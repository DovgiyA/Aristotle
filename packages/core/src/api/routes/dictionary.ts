// Маршруты Словаря Сети (contracts/http-api.md фичи 005): применённая версия и её документ, подача
// версии (DICT-16, DICT-17), элементы с эффективными свойствами (DICT-02, DICT-07), списки Стоп-листа
// и их строки (DICT-41, DICT-42). Чтение — все роли; подача — Старший с подтверждением присутствия на
// API Станций и подписью Ключом Координатора на API сопровождения (NET-54, APP-34).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  DictElementsQuery,
  DictElementsResponse,
  DictionaryCurrent,
  DictionaryNumberParams,
  DictionaryStateResponse,
  PageQuery,
  StopListCodeParams,
  StopListEntriesResponse,
  StopListsResponse,
  type DictElementView,
  trimSpace,
} from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { ApiError } from "../errors.ts";
import { applyDictionaryVersion, dictionaryDocumentText, dictionaryState } from "../../dictionary/apply.ts";
import { currentDictionary, type DictElement } from "../../dictionary/current.ts";
import { getRecord, withView } from "../../bank/records.ts";
import { SLOVAR_MAX_BODY_BYTES, StopListIndicatorsQuery, buildStopListMatcher } from "@aristotel/protocol";

/** Предел тела версии Словаря — 64 МиБ плюс обвязка документа (contracts/slovar-v1.md). */
/**
 * Предел запроса подачи версии: тело до 64 МиБ едет JSON-строкой, экранирование кавычек и обратных
 * косых до удваивает её; плюс подписи и обёртка (DICT-46; T261).
 */
export const DICTIONARY_BODY_LIMIT = 2 * SLOVAR_MAX_BODY_BYTES + 1024 * 1024;

export function elementView(db: Db, el: DictElement): DictElementView {
  const dict = currentDictionary(db);
  const props = el.kind === "indicator_type" ? ((dict?.indicatorType(el.id) as unknown as Record<string, unknown> | undefined) ?? el.props) : el.props;
  return { id: el.id, code: el.code, label: el.label, kind: el.kind, level: el.level, state: el.state, canonicalId: el.canonicalId, sinceVersion: el.sinceVersion, props };
}

export function dictionaryRoutes(app: FastifyInstance, db: Db): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.get("/api/dictionary", { schema: { response: { 200: DictionaryStateResponse } }, config: { right: "dictionary.read", maintenance: true } }, async () => ({
    current: dictionaryState(db),
  }));

  api.get(
    "/api/dictionary/versions/:number",
    { schema: { params: DictionaryNumberParams }, config: { right: "dictionary.read", maintenance: true } },
    async (request, reply) => {
      const text = dictionaryDocumentText(db, request.params.number);
      if (text === undefined) throw new ApiError("not_found", { id: String(request.params.number) });
      return reply.type("application/json; charset=utf-8").send(text);
    },
  );

  api.post(
    "/api/dictionary/versions",
    {
      bodyLimit: DICTIONARY_BODY_LIMIT,
      schema: { response: { 200: DictionaryCurrent, 201: DictionaryCurrent } },
      config: { right: "dictionary.apply", maintenance: true },
    },
    async (request, reply) => {
      const actor = request.via === "maintenance" ? ({ bySignature: true } as const) : { memberId: request.memberId };
      const result = applyDictionaryVersion(db, actor, JSON.stringify(request.body));
      return reply.status(result.status).send(result.current);
    },
  );

  api.get(
    "/api/dictionary/elements",
    { schema: { querystring: DictElementsQuery, response: { 200: DictElementsResponse } }, config: { right: "dictionary.read" } },
    async (request) => {
      const dict = currentDictionary(db);
      if (dict === undefined) return { items: [] };
      const q = request.query;
      const items = [...dict.elements()]
        .filter((el) => (q.kind === undefined || el.kind === q.kind) && (q.code === undefined || el.code === q.code) && (q.level === undefined || el.level === q.level))
        .sort((a, b) => (a.kind === b.kind ? (a.code < b.code ? -1 : 1) : a.kind < b.kind ? -1 : 1))
        .map((el) => elementView(db, el));
      return { items };
    },
  );

  api.get("/api/dictionary/stop-lists", { schema: { response: { 200: StopListsResponse } }, config: { right: "dictionary.read" } }, async () => ({
    items: db.prepare("SELECT id, code, label, source, builtAt, rows, level FROM stop_list ORDER BY level, code").all().map((r) => ({
      id: String(r["id"]),
      code: String(r["code"]),
      label: String(r["label"]),
      source: String(r["source"]),
      builtAt: String(r["builtAt"]),
      rows: Number(r["rows"]),
      level: String(r["level"]),
    })),
  }));

  api.get(
    "/api/dictionary/stop-lists/:code/entries",
    { schema: { params: StopListCodeParams, querystring: PageQuery, response: { 200: StopListEntriesResponse } }, config: { right: "dictionary.read" } },
    async (request) => {
      const list = db.prepare("SELECT id FROM stop_list WHERE code = ?").get(request.params.code);
      if (list === undefined) throw new ApiError("not_found", { id: request.params.code });
      const offset = pageOffset(request.query.cursor);
      const limit = request.query.limit ?? 200;
      const rows = db
        .prepare("SELECT id, typeId, kind, value, normalized, note FROM stop_list_entry WHERE listId = ? ORDER BY rowid LIMIT ? OFFSET ?")
        .all(String(list["id"]), limit + 1, offset);
      // Строка — как её сверяет программа: тип — канон, нормализованная форма — по Классу канона, у строк
      // Сети и «Местного» одинаково (DICT-41, DICT-12; T216).
      const dict = currentDictionary(db);
      return {
        items: rows.slice(0, limit).map((r) => {
          const entry = dict?.stopEntries.get(String(r["id"]));
          return {
            id: String(r["id"]),
            typeId: entry?.typeId ?? String(r["typeId"]),
            kind: String(r["kind"]),
            value: String(r["value"]),
            normalized: entry?.normalized ?? String(r["normalized"]),
            note: String(r["note"]),
          };
        }),
        cursor: rows.length > limit ? String(offset + limit) : null,
      };
    },
  );

  // Индикаторы с пометкой списка Стоп-листа — фильтр поиска (DICT-44) без выдачи фичи 011.
  api.get("/api/indicators", { schema: { querystring: StopListIndicatorsQuery }, config: { right: "record.read" } }, async (request) => {
    const list = db.prepare("SELECT id FROM stop_list WHERE code = ?").get(request.query.stopList);
    if (list === undefined) throw new ApiError("not_found", { id: request.query.stopList });
    const reader = { role: request.memberRole };
    const offset = pageOffset(request.query.cursor);
    const limit = request.query.limit ?? 100;
    // Значение помечено списком, если его строка совпала со строкой этого списка, — и когда первой
    // совпала строка другого списка (Сети и «Местного» вместе; DICT-44; T239).
    const dict = currentDictionary(db);
    const listId = String(list["id"]);
    const entries = dict === undefined ? [] : [...dict.stopEntries.values()].filter((e) => e.listId === listId && !e.dormant);
    const matcher = buildStopListMatcher(entries, (typeId) => dict?.indicatorType(typeId)?.normClass);
    const rows = db
      .prepare(
        `SELECT v.recordId, v.canonicalTypeId, v.normalized, r.fields FROM indicator_value v JOIN record r ON r.id = v.recordId
         WHERE v.stopListEntryId IS NOT NULL ${reader.role === "observer" ? "AND r.secret = 0" : ""} ORDER BY r.createdAt, r.id`,
      )
      .all()
      .filter((r) => {
        const value = (JSON.parse(String(r["fields"])) as { value?: unknown }).value;
        const normalized = r["normalized"] === null ? (typeof value === "string" ? trimSpace(value) : "") : String(r["normalized"]);
        return matcher.match(String(r["canonicalTypeId"]), normalized) !== undefined;
      })
      .slice(offset, offset + limit + 1);
    const items = rows.slice(0, limit).map((r) => withView(db, getRecord(db, String(r["recordId"]), reader)!, reader));
    return { items, cursor: rows.length > limit ? String(offset + limit) : null };
  });
}

/** Курсор страницы — неотрицательное целое в безопасном диапазоне, иначе 400 (DICT-44; T184). */
function pageOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const n = /^\d{1,15}$/.test(cursor) ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new ApiError("invalid_request", { detail: `cursor=${cursor.slice(0, 32)}` });
  return n;
}
