// Местное расширение Группы (research R10 фичи 005; DICT-03, DICT-05 … DICT-08, DICT-11, DICT-45,
// DICT-56, DICT-57, DICT-60, DICT-61; Clarifications фичи 005): любое изменение — предложением
// Участника или Старшего, решает Старший; ослабление правил Сети — 422 local_weakening. Местные
// элементы лежат в dict_element с level = 'local' и не трогаются материализацией версий Сети.
import { randomUUIDv7 } from "node:crypto";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { domainToASCII } from "node:url";
import {
  EXTERNAL_STANDARD_ENUMS,
  checkFormat,
  isMessageCode,
  isStandardCode,
  patternNormalForm,
  normalize,
  LocalPayloads,
  PROGRAM_ENUMS,
  isNormClass,
  isTightening,
  message,
  parseCidr,
  parseFormat,
  type LocalProposalKind,
  type LocalProposalView,
  trimSpace,
} from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { assertActor } from "../rights/rights.ts";
import { currentDictionary, invalidateDictionary, type AppliedDictionary } from "../dictionary/current.ts";
import { stopEntryNormalized } from "../dictionary/materialize.ts";
import { registerApplyStep } from "../dictionary/apply.ts";
import { formatContext, recomputeAll } from "../model/indicator-value.ts";
import { markAutoSecret } from "../model/types.ts";

function weakening(detail: string): ApiError {
  return new ApiError("local_weakening", { detail });
}

/** Отказ называет поле по-русски (конституция VIII; T238); неизвестное поле — как есть. */
function invalid(field: string): ApiError {
  const code = `local_field_${field}`;
  return new ApiError("invalid_request", { detail: isMessageCode(code) ? message(code) : field });
}

/** Поле, на котором предложение не прошло схему: из пути ошибки или из «нет обязательного/лишнее». */
function schemaField(schema: TSchema, payload: unknown): string {
  for (const e of Value.Errors(schema, payload) as Iterable<{ instancePath?: string; params?: { requiredProperties?: string[]; additionalProperties?: string[] } }>) {
    const top = String(e.instancePath ?? "").split("/")[1];
    if (top !== undefined && top !== "") return top;
    const named = e.params?.requiredProperties?.[0] ?? e.params?.additionalProperties?.[0];
    if (named !== undefined) return named;
  }
  return "payload";
}

function journal(db: Db, actorId: string, action: string, subjectId: string, details: Record<string, unknown>): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, 'local-extension', ?, ?)").run(
    new Date().toISOString(),
    actorId,
    action,
    subjectId,
    JSON.stringify(details),
  );
}

function requireDict(db: Db): AppliedDictionary {
  const dict = currentDictionary(db);
  if (dict === undefined) throw new ApiError("dictionary_missing");
  return dict;
}

function groupCode(dict: AppliedDictionary): string {
  if (dict.groupCode === undefined) throw new ApiError("network_not_launched");
  return dict.groupCode;
}

/** Элемент перечня по Коду или Идентификатору. */
function enumOf(dict: AppliedDictionary, ref: string) {
  const el = dict.element(ref) ?? dict.byCode("enum", ref);
  return el?.kind === "enum" ? el : undefined;
}

/**
 * Перечень местно не дополняется: закрыт в данных или это перечень поля программы — его закрытость не
 * зависит от флага версии (DICT-60, BANK-63; T204).
 */
function closedEnum(dict: AppliedDictionary, code: string): boolean {
  return (PROGRAM_ENUMS as readonly string[]).includes(code) || dict.byCode("enum", code)?.props["closed"] === true;
}

/** Проверка предложения по Словарю — и при подаче, и при решении. */
function check(dict: AppliedDictionary, kind: LocalProposalKind, payload: Record<string, unknown>): void {
  const schema: TSchema = LocalPayloads[kind];
  if (!Value.Check(schema, payload)) throw invalid(schemaField(schema, payload));
  // Текст — правильно построенный Юникод: одинокий суррогат SQLite заменил бы, и строка «Местного»
  // уже не совпала бы с тем же значением (DICT-37, DICT-40; T187).
  for (const [field, v] of Object.entries(payload)) if (typeof v === "string" && !v.isWellFormed()) throw invalid(field);
  switch (kind) {
    case "type": {
      const object = String(payload["object"]);
      if (object !== "@item" && dict.element(object)?.kind !== "object_type") throw invalid("object");
      let format: ReturnType<typeof parseFormat>;
      try {
        format = parseFormat(String(payload["format"]));
      } catch {
        throw invalid("format");
      }
      // Местный тип не открывает закрытый перечень поля программы для своих значений (DICT-60, BANK-63).
      // Перечень формата — из Словаря: иначе каждое значение навсегда «вне Словаря» (DICT-10; T194).
      if (format.kind === "enum" && dict.byCode("enum", format.enumCode) === undefined) throw invalid("format");
      if (format.kind === "enum" && closedEnum(dict, format.enumCode)) {
        throw weakening(message("local_weakening_closed", { code: format.enumCode }));
      }
      if (payload["normClass"] !== undefined && !isNormClass(String(payload["normClass"]))) throw invalid("normClass");
      if (dict.byCode("indicator_type", `${groupCode(dict)}:${String(payload["code"])}`) !== undefined) throw invalid("code");
      return;
    }
    case "enum_value": {
      const en = enumOf(dict, String(payload["enum"]));
      if (en === undefined) throw invalid("enum");
      // Закрытые перечни полей программы местно не дополняются (DICT-60, BANK-63).
      if (closedEnum(dict, en.code)) throw weakening(message("local_weakening_closed", { code: en.code }));
      // Код — snake_case, у перечней по внешним стандартам — идентификатор стандарта (DICT-09, DICT-63; T209).
      // У перечней по внешним стандартам — форма стандарта (DICT-63; T264).
      const external = (EXTERNAL_STANDARD_ENUMS as readonly string[]).includes(en.code);
      if (external ? !isStandardCode(en.code, String(payload["code"])) : !/^[a-z][a-z0-9_]*$/.test(String(payload["code"]))) throw invalid("code");
      if (dict.enumValues(en.id).some((v) => v.code === payload["code"])) throw invalid("code");
      // Прежний Код (синоним перечня) занят: им читаются прежние значения (DICT-64, T259; T275).
      if (Object.hasOwn((en.props["aliases"] as Record<string, string> | undefined) ?? {}, String(payload["code"]))) throw invalid("code");
      return;
    }
    case "template_field": {
      const cls = dict.enumValue("item_class", String(payload["class"]));
      if (cls === undefined) throw invalid("class");
      // Подтип — у которого есть шаблон этого Класса (T210).
      if (payload["subtype"] !== undefined) {
        const sub = dict.enumValue("item_subtype", String(payload["subtype"]));
        if (sub === undefined || dict.templates(cls.id, sub.id).length === 0) throw invalid("subtype");
      }
      // Блок — из шаблона Сети этого Класса и подтипа: Группа добавляет поле, а не блок (DICT-08, DATA-23; T271).
      const subId = payload["subtype"] === undefined ? null : (dict.enumValue("item_subtype", String(payload["subtype"]))?.id ?? null);
      if (!dict.templates(cls.id, subId).some((r) => !r.local && r.block === payload["block"])) throw invalid("block");
      const type = dict.element(String(payload["indicatorType"]));
      if (type?.kind !== "indicator_type") throw invalid("indicatorType");
      // В шаблон Группа добавляет поля только своих местных типов (DICT-08).
      // Местный тип, уже склеенный в тип Сети, — тоже тип Сети для шаблона (DICT-23; T193).
      if (type.level !== "local" || dict.canonicalId(type.id) !== type.id) throw weakening(message("local_weakening_network_field", { code: type.code }));
      // Только свой местный тип: чужой в Словарь получателя не входит (DICT-25; T279).
      if (!type.code.startsWith(`${groupCode(dict)}:`)) throw weakening(message("local_weakening_foreign", { code: type.code }));
      return;
    }
    case "stop_list_entry": {
      if ("remove" in payload) {
        // Удаляется только строка списка «Местное» этой Группы (DICT-45).
        const entry = dict.stopEntries.get(String(payload["remove"]));
        if (entry === undefined || dict.stopLists.get(entry.listId)?.level !== "local") throw invalid("remove");
        return;
      }
      const type = dict.indicatorType(String(payload["type"]));
      if (type === undefined) throw invalid("type");
      // Тип строки — Сети или свой местный: строка по чужому местному типу «Местное» не пополняет (DICT-25, DICT-45; T279).
      const own = dict.element(String(payload["type"]));
      if (own !== undefined && own.level === "local" && !own.code.startsWith(`${groupCode(dict)}:`)) throw invalid("type");
      if (payload["kind"] === "range" && type.normClass !== "ip") throw invalid("range");
      // «Значение» проходит формат своего типа (приложение §8; T278).
      if (payload["kind"] === "value") {
        let result: string;
        try {
          result = checkFormat(parseFormat(type.format), String(payload["value"]), formatContext(dict));
        } catch {
          result = "format_violation";
        }
        if (result === "format_violation" || result === "not_a_value") throw invalid("value");
      }
      // Диапазон — разбираемый CIDR, иначе Стоп-лист не собрать при принятии (DICT-41; T176).
      if (payload["kind"] === "range" && parseCidr(trimSpace(String(payload["value"]))) === undefined) throw invalid("range");
      // «Значение» нормализуется Классом типа, повтор после нормализации — отказ, как у строк Сети
      // (DICT-41, DICT-45; T228).
      if (payload["kind"] === "value" && type.normClass !== null && !normalize(type.normClass, String(payload["value"]), { toAscii: domainToASCII }).ok) throw invalid("value");
      // Шаблон сравнивается с нормализованными значениями: он или приводится Классом, или уже записан в
      // нормализованной форме (подстановки заменены цифрой для проверки) — иначе не совпадёт ни с чем (T245).
      // Правило одно с шаблонами Сети (T258): префиксные шаблоны в нормальной форме принимаются; шаблон, который не совпадёт
      // ни с чем, — сначала этот отказ, а не «на весь тип» (T290).
      if (payload["kind"] === "pattern" && patternNormalForm(type.normClass, String(payload["value"]), { toAscii: domainToASCII }) === undefined) {
        throw new ApiError("invalid_request", { detail: message("local_pattern_not_normal", { cls: String(type.normClass) }) });
      }
      // Строка на весь тип (шаблон без буквальных знаков, диапазон /0) — это смена опознания типа, а её
      // делает только Сеть (DICT-56, DICT-07; решение T272).
      // Весь тип — по нормализованной форме шаблона: «*.» у домена и «*» с мягким переносом — тоже (T277).
      const normalForm = payload["kind"] === "pattern" ? (patternNormalForm(type.normClass, String(payload["value"]), { toAscii: domainToASCII }) ?? trimSpace(String(payload["value"]))) : "";
      const coversAll =
        // Разделители нормальной формы (точка, дефис, двоеточие) буквальными знаками не считаются: «*.*» у
        // домена, «*-*-*-*-*» у GUID накрывают весь тип (T290).
        (payload["kind"] === "pattern" && (/^[*?.:-]+$/.test(trimSpace(String(payload["value"]))) || /^[*?.:-]+$/.test(normalForm))) ||
        (payload["kind"] === "range" && parseCidr(trimSpace(String(payload["value"])))?.prefix === 0);
      if (coversAll) throw weakening(message("local_weakening_catch_all", { value: trimSpace(String(payload["value"])), code: dict.element(dict.canonicalId(String(payload["type"])))?.code ?? "" }));
      const canonical = dict.canonicalId(String(payload["type"]));
      const normalized = stopEntryNormalized(String(payload["kind"]), String(payload["value"]), type.normClass);
      const repeat = [...dict.stopEntries.values()].some(
        (e) => dict.stopLists.get(e.listId)?.level === "local" && e.typeId === canonical && e.kind === payload["kind"] && e.normalized === normalized,
      );
      if (repeat) throw new ApiError("invalid_request", { detail: message("local_stop_repeat") });
      return;
    }
    case "override": {
      const el = dict.element(String(payload["element"]));
      if (el?.kind !== "indicator_type" || el.level !== "network") throw invalid("element");
      // Поглощённый тип читается как канон: ужесточать — канон, иначе правило легло бы на часть значений (T244).
      if (el.state === "absorbed") throw weakening(message("local_weakening_absorbed", { code: el.code, canonical: dict.element(dict.canonicalId(el.id))?.code ?? "" }));
      const current = dict.indicatorType(el.id)!;
      if (!isTightening(String(payload["property"]), payload["value"], current)) {
        const label = `label_override_${String(payload["property"])}`;
        throw weakening(message("local_weakening_override", { code: el.code, property: isMessageCode(label) ? message(label) : String(payload["property"]) }));
      }
      return;
    }
  }
}

function rowToView(r: Record<string, unknown>): LocalProposalView {
  const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    id: String(r["id"]),
    kind: String(r["kind"]) as LocalProposalKind,
    payload: JSON.parse(String(r["payload"])) as Record<string, unknown>,
    state: String(r["state"]) as LocalProposalView["state"],
    proposedBy: String(r["proposedBy"]),
    proposedAt: String(r["proposedAt"]),
    decidedBy: s("decidedBy"),
    decidedAt: s("decidedAt"),
    reason: s("reason"),
    resultId: s("resultId"),
  };
}

function getProposal(db: Db, id: string): LocalProposalView {
  const r = db.prepare("SELECT * FROM local_proposal WHERE id = ?").get(id);
  if (r === undefined) throw new ApiError("not_found", { id });
  return rowToView(r);
}

export function listProposals(db: Db, state?: string): LocalProposalView[] {
  const rows = state === undefined ? db.prepare("SELECT * FROM local_proposal ORDER BY proposedAt, id").all() : db.prepare("SELECT * FROM local_proposal WHERE state = ? ORDER BY proposedAt, id").all(state);
  return rows.map(rowToView);
}

export function propose(db: Db, memberId: string, kind: LocalProposalKind, payload: Record<string, unknown>): LocalProposalView {
  const dict = requireDict(db);
  check(dict, kind, payload);
  return inTransaction(db, () => {
    assertActor(db, memberId, "local-extension.propose");
    const id = randomUUIDv7();
    db.prepare("INSERT INTO local_proposal (id, kind, payload, state, proposedBy, proposedAt) VALUES (?, ?, ?, 'proposed', ?, ?)").run(
      id,
      kind,
      JSON.stringify(payload),
      memberId,
      new Date().toISOString(),
    );
    journal(db, memberId, "local-extension.propose", id, { kind });
    return getProposal(db, id);
  });
}

/**
 * Список «Местное» Группы есть с применения Словаря, пустой до первой строки (FR-030, DICT-45; T291):
 * шаг применения версии создаёт его, если его ещё нет.
 */
export function registerLocalStopListStep(): void {
  registerApplyStep((db, dictionary) => {
    if (dictionary.groupCode !== undefined) localStopList(db, dictionary.groupCode);
    return {};
  });
}

function localStopList(db: Db, group: string): string {
  const code = `${group}:local`;
  const row = db.prepare("SELECT id FROM stop_list WHERE code = ?").get(code);
  if (row !== undefined) return String(row["id"]);
  const id = randomUUIDv7();
  db.prepare("INSERT INTO stop_list (id, code, label, source, builtAt, rows, level) VALUES (?, ?, ?, ?, ?, 0, 'local')").run(
    id,
    code,
    message("local_list_label"),
    group,
    new Date().toISOString().slice(0, 10),
  );
  return id;
}

/** Применить принятое предложение; вернуть Идентификатор созданного элемента или строки. */
function applyProposal(db: Db, dict: AppliedDictionary, p: LocalProposalView, by: string): { resultId: string; affectedType?: string; affectedTypes?: string[] } {
  const pl = p.payload;
  switch (p.kind) {
    case "type": {
      const id = randomUUIDv7();
      const props = { object: pl["object"], format: pl["format"], comparable: false, normClass: pl["normClass"] ?? null, identifying: "none", autoSecret: pl["autoSecret"] === true };
      db.prepare("INSERT INTO dict_element (id, code, label, kind, level, state, canonicalId, sinceVersion, props) VALUES (?, ?, ?, 'indicator_type', 'local', 'active', NULL, NULL, ?)").run(
        id,
        `${groupCode(dict)}:${String(pl["code"])}`,
        String(pl["label"]),
        JSON.stringify(props),
      );
      return { resultId: id };
    }
    case "enum_value": {
      const id = randomUUIDv7();
      const en = enumOf(dict, String(pl["enum"]))!;
      db.prepare("INSERT INTO dict_element (id, code, label, kind, level, state, canonicalId, sinceVersion, props) VALUES (?, ?, ?, 'enum_value', 'local', 'active', NULL, NULL, ?)").run(
        id,
        String(pl["code"]),
        String(pl["label"]),
        JSON.stringify({ enum: en.id }),
      );
      // Значения этого перечня у Индикаторов больше не «вне Словаря» — пересчёт типов с его форматом (T225).
      const affectedTypes = [...dict.elements()]
        .filter((e) => e.kind === "indicator_type")
        .filter((e) => {
          try {
            const f = parseFormat(String(e.props["format"]));
            // «гео» читает Коды точности из geo_precision (DICT-65; T250).
            return (f.kind === "enum" && f.enumCode === en.code) || (f.kind === "geo" && en.code === "geo_precision");
          } catch {
            return false;
          }
        })
        .map((e) => e.id);
      return { resultId: id, affectedTypes };
    }
    case "template_field": {
      const cls = dict.enumValue("item_class", String(pl["class"]))!;
      const sub = pl["subtype"] === undefined ? null : dict.enumValue("item_subtype", String(pl["subtype"]))!.id;
      const type = dict.element(String(pl["indicatorType"]))!;
      const field = { label: pl["label"], required: false, defaultSource: "manual", target: { objectKind: type.props["object"], indicatorTypes: [type.id] } };
      const position = Number(db.prepare("SELECT coalesce(max(position), 0) + 1 AS n FROM dict_template WHERE classId = ? AND subtypeId IS ? AND local = 1").get(cls.id, sub)?.["n"]);
      db.prepare("INSERT INTO dict_template (classId, subtypeId, block, position, field, local) VALUES (?, ?, ?, ?, ?, 1)").run(cls.id, sub, String(pl["block"]), position, JSON.stringify(field));
      journal(db, by, "local-extension.change", p.id, { kind: p.kind });
      return { resultId: sub === null ? `${cls.id}:${position}` : `${cls.id}:${sub}:${position}` };
    }
    case "stop_list_entry": {
      if ("remove" in pl) return removeLocalStopEntry(db, String(pl["remove"]), by);
      const listId = localStopList(db, groupCode(dict));
      const id = randomUUIDv7();
      const type = dict.canonicalId(String(pl["type"]));
      const normalized = stopEntryNormalized(String(pl["kind"]), String(pl["value"]), dict.indicatorType(type)?.normClass);
      db.prepare("INSERT INTO stop_list_entry (id, listId, typeId, kind, value, normalized, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, listId, type, String(pl["kind"]), String(pl["value"]), normalized, String(pl["note"]));
      db.prepare("UPDATE stop_list SET rows = rows + 1 WHERE id = ?").run(listId);
      journal(db, by, "stop-list.local.add", id, { type, kind: pl["kind"] });
      return { resultId: id, affectedType: type };
    }
    case "override": {
      db.prepare("INSERT OR REPLACE INTO local_override (elementId, property, value, setBy, setAt) VALUES (?, ?, ?, ?, ?)").run(
        String(pl["element"]),
        String(pl["property"]),
        JSON.stringify(pl["value"]),
        by,
        new Date().toISOString(),
      );
      journal(db, by, "local-extension.change", p.id, { kind: p.kind, element: pl["element"], property: pl["property"] });
      return { resultId: String(pl["element"]), affectedType: String(pl["element"]) };
    }
  }
}

export function accept(db: Db, seniorId: string, id: string): LocalProposalView {
  try {
    return inTransaction(db, () => {
      assertActor(db, seniorId, "local-extension.decide");
      const p = getProposal(db, id);
      if (p.state !== "proposed") throw new ApiError("proposal_not_open");
      const dict = requireDict(db);
      check(dict, p.kind, p.payload);
      const result = applyProposal(db, dict, p, seniorId);
      db.prepare("UPDATE local_proposal SET state = 'accepted', decidedBy = ?, decidedAt = ?, resultId = ? WHERE id = ?").run(seniorId, new Date().toISOString(), result.resultId, id);
      journal(db, seniorId, "local-extension.accept", id, { kind: p.kind, resultId: result.resultId });
      // Производное пересчитывается по обновлённому Словарю в той же транзакции.
      invalidateDictionary(db);
      const updated = currentDictionary(db)!;
      const affected = [...(result.affectedType === undefined ? [] : [result.affectedType]), ...(result.affectedTypes ?? [])].map((t) => updated.canonicalId(t));
      if (affected.length > 0) recomputeAll(db, updated, new Set(affected));
      if (p.kind === "override" && p.payload["property"] === "autoSecret") markAutoSecret(db, updated, seniorId, dict);
      return getProposal(db, id);
    });
  } finally {
    invalidateDictionary(db);
  }
}

export function reject(db: Db, seniorId: string, id: string, reason: string): LocalProposalView {
  if (!reason.isWellFormed()) throw invalid("reason");
  return inTransaction(db, () => {
    assertActor(db, seniorId, "local-extension.decide");
    const p = getProposal(db, id);
    if (p.state !== "proposed") throw new ApiError("proposal_not_open");
    db.prepare("UPDATE local_proposal SET state = 'rejected', decidedBy = ?, decidedAt = ?, reason = ? WHERE id = ?").run(seniorId, new Date().toISOString(), reason, id);
    journal(db, seniorId, "local-extension.reject", id, { kind: p.kind, reason });
    return getProposal(db, id);
  });
}

/**
 * Убрать строку «Местного» по принятому предложению (DICT-45; Clarifications фичи 005): пометка с
 * значений снимается пересчётом по типу строки в accept.
 */
function removeLocalStopEntry(db: Db, entryId: string, by: string): { resultId: string; affectedType: string } {
  const row = db.prepare("SELECT e.typeId, e.listId FROM stop_list_entry e JOIN stop_list l ON l.id = e.listId WHERE e.id = ? AND l.level = 'local'").get(entryId);
  if (row === undefined) throw new ApiError("not_found", { id: entryId });
  db.prepare("DELETE FROM stop_list_entry WHERE id = ?").run(entryId);
  db.prepare("UPDATE stop_list SET rows = rows - 1 WHERE id = ?").run(String(row["listId"]));
  journal(db, by, "stop-list.local.remove", entryId, { type: row["typeId"] });
  return { resultId: entryId, affectedType: String(row["typeId"]) };
}

/** GET /api/local-extension: местные типы, значения, поля шаблона, ужесточения, строки «Местного» этой Группы. */
export function localExtensionView(db: Db): Record<string, unknown> {
  const dict = currentDictionary(db);
  const group = dict?.groupCode;
  const local = db.prepare("SELECT id, code, label, kind, state, canonicalId, props FROM dict_element WHERE level = 'local' ORDER BY code").all();
  const own = (code: string) => group !== undefined && code.startsWith(`${group}:`);
  // Состояние и канон — у поглощённых видно, во что склеены (DICT-23, T211; T229); рядом с
  // Идентификаторами — Коды, по которым элементы знают люди.
  const codeOf = (id: unknown) => (typeof id === "string" ? (dict?.element(id)?.code ?? null) : null);
  const canonicalId = (r: Record<string, unknown>) => (r["canonicalId"] === null ? null : String(r["canonicalId"]));
  return {
    types: local
      .filter((r) => r["kind"] === "indicator_type" && own(String(r["code"])))
      .map((r) => ({ id: String(r["id"]), code: String(r["code"]), label: String(r["label"]), state: String(r["state"]), canonicalId: canonicalId(r), props: JSON.parse(String(r["props"])) })),
    enumValues: local
      .filter((r) => r["kind"] === "enum_value")
      .map((r) => {
        const en = (JSON.parse(String(r["props"])) as { enum: string }).enum;
        return { id: String(r["id"]), code: String(r["code"]), label: String(r["label"]), enum: en, enumCode: codeOf(en), state: String(r["state"]), canonicalId: canonicalId(r) };
      }),
    templateFields: db
      .prepare("SELECT classId, subtypeId, block, position, field FROM dict_template WHERE local = 1 ORDER BY classId, subtypeId, position")
      .all()
      .map((r) => ({
        classId: String(r["classId"]),
        classCode: codeOf(r["classId"]),
        subtypeId: r["subtypeId"] === null ? null : String(r["subtypeId"]),
        subtypeCode: codeOf(r["subtypeId"]),
        block: String(r["block"]),
        field: JSON.parse(String(r["field"])),
      })),
    overrides: db
      .prepare("SELECT elementId, property, value FROM local_override ORDER BY elementId, property")
      .all()
      .map((r) => ({ element: String(r["elementId"]), elementCode: codeOf(r["elementId"]), property: String(r["property"]), value: JSON.parse(String(r["value"])) })),
    stopList: db
      .prepare("SELECT e.id, e.typeId, e.kind, e.value, e.note FROM stop_list_entry e JOIN stop_list l ON l.id = e.listId WHERE l.level = 'local' ORDER BY e.rowid")
      .all()
      // dormant — строка не действует: тип перестал быть ip (T182, DICT-17).
      .map((r) => ({
        id: String(r["id"]),
        type: String(r["typeId"]),
        typeCode: codeOf(r["typeId"]),
        kind: String(r["kind"]),
        value: String(r["value"]),
        note: String(r["note"]),
        dormant: dict?.stopEntries.get(String(r["id"]))?.dormant === true,
      })),
  };
}
