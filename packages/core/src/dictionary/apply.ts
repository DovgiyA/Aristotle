// Применение версии Словаря Сети (research R6 фичи 005; DICT-01, DICT-12, DICT-17, DICT-18, DICT-22,
// DICT-23, DICT-46, DICT-58; Clarifications фичи 005): одна транзакция BEGIN IMMEDIATE — номер строго
// следующий, подпись Ключом Координатора из применённого Реестра Сети, требования к программе,
// содержимое, запись версии, материализация, склейки местных типов, пересчёт производного, журнал.
// Отказ — запись dictionary.reject отдельной транзакцией после отката, как у Реестра.
import { domainToASCII } from "node:url";
import {
  ELEMENT_KINDS,
  PROGRAM_ENUMS,
  normalize,
  patternNormalForm,
  FORMAT_NAMES,
  MATERIAL_KINDS,
  PSEUDO_REFS,
  parseCidr,
  parseFormat,
  programReadsByCode,
  programReadsElement,
  SLOVAR_FORMAT,
  SLOVAR_MAX_BODY_BYTES,
  SignedDocumentError,
  SlovarFormatError,
  bodySha256,
  isNormClass,
  keyFingerprint,
  message,
  parseSignedDocument,
  parseSlovarBody,
  serializeSignedDocument,
  signerAmong,
  type MessageCode,
  type SignedDocument,
  type SlovarBody,
  type SlovarRejectReason,
  trimSpace,
} from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { assertActor } from "../rights/rights.ts";
import { registryState } from "../network/registry.ts";
import { networkEvents } from "../network/events.ts";
import { materialize } from "./materialize.ts";
import { absorptionCycle, elementsFormatContext, stopValueBreaksFormat } from "./build.ts";
import { currentDictionary, invalidateDictionary, type AppliedDictionary } from "./current.ts";

/** Кто подаёт версию: Член Группы сеанса Станции или — на API сопровождения — владелец подписавшего ключа (NET-54). */
export type DictionaryActor = { memberId: string } | { bySignature: true };

export interface DictionaryCurrent {
  number: number;
  bodySha256: string;
  appliedAt: string;
  appliedBy: { id: string | null; label: string };
  signedBy: { key: string; keyFingerprint: string };
  /** Счётчики применения — только в ответе 201 (contracts/cli.md: `dictionary apply` их печатает). */
  applied?: Record<string, number>;
}

/**
 * Шаги после материализации — пересчёт производного Записей модели (indicator_value, метка Секрет по
 * ROLE-25). Регистрирует модель данных; возвращает счётчики для записи dictionary.apply.
 */
/** Шаг применения; previous — Словарь до этой версии (undefined у версии 1). */
export type ApplyStep = (db: Db, dictionary: AppliedDictionary, number: number, actorId: string | null, previous: AppliedDictionary | undefined) => Record<string, number>;
const applySteps: ApplyStep[] = [];
export function registerApplyStep(step: ApplyStep): void {
  if (!applySteps.includes(step)) applySteps.push(step);
}

class Rejected extends Error {
  readonly reason: SlovarRejectReason;
  readonly params: Record<string, string | number>;
  readonly number: number | undefined;
  constructor(reason: SlovarRejectReason, params: Record<string, string | number> = {}, number?: number) {
    super(reason);
    this.reason = reason;
    this.params = params;
    this.number = number;
  }
}

function rejectError(r: Rejected): ApiError {
  const reasonText = message(`dictionary_reason_${r.reason}` as MessageCode, r.params);
  const extra: Record<string, unknown> = { reason: r.reason };
  if (r.reason === "gap") extra["expected"] = r.params["expected"];
  return new ApiError("dictionary_rejected", { reason: reasonText }, extra);
}

function journal(db: Db, actorId: string | null, action: string, number: number | undefined, details: Record<string, unknown>): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, 'dictionary', ?, ?)").run(
    new Date().toISOString(),
    actorId,
    action,
    number === undefined ? "?" : String(number),
    JSON.stringify(details),
  );
}

function lastApplied(db: Db): { number: number; bodySha256: string; body: SlovarBody } | undefined {
  const row = db.prepare("SELECT number, document, bodySha256 FROM dictionary_version ORDER BY number DESC LIMIT 1").get();
  if (row === undefined) return undefined;
  const doc = parseSignedDocument(String(row["document"]), SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES });
  return { number: Number(row["number"]), bodySha256: String(row["bodySha256"]), body: parseSlovarBody(doc.body) };
}

function keyOwner(db: Db, publicKey: string): string | null {
  const row = db.prepare("SELECT memberId FROM coordinator_key WHERE publicKey = ? ORDER BY rowid DESC LIMIT 1").get(publicKey);
  return row === undefined ? null : String(row["memberId"]);
}

/**
 * Форма сырого тела до номера и требований (research R6, шаг 1): объект, массивы элементов, списков,
 * склеек и шаблонов, элементы — объекты, требования — массивы строк. Иначе — format, а не 500.
 */
function wellShaped(raw: unknown): boolean {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(raw)) return false;
  for (const key of ["elements", "stopLists", "merges", "templates"]) {
    const list = raw[key];
    if (!Array.isArray(list) || !list.every(isObject)) return false;
  }
  const req = raw["programRequirements"];
  if (!isObject(req)) return false;
  return ["normClasses", "materialKinds"].every((k) => Array.isArray(req[k]) && (req[k] as unknown[]).every((x) => typeof x === "string"));
}

/** Требования к программе: Классы нормализации, виды Материала, виды элементов (DICT-01, DICT-26, BANK-63). */
function unsupported(raw: unknown): string[] {
  const body = raw as {
    programRequirements?: { normClasses?: unknown[]; materialKinds?: unknown[] };
    elements?: { id?: unknown; code?: unknown; kind?: unknown; props?: { normClass?: unknown; enum?: unknown } }[];
  };
  const items = new Set<string>();
  const knownKind = (k: unknown) => typeof k !== "string" || (MATERIAL_KINDS as readonly string[]).includes(k);
  for (const c of body.programRequirements?.normClasses ?? []) if (typeof c === "string" && !isNormClass(c)) items.add(c);
  for (const k of body.programRequirements?.materialKinds ?? []) if (!knownKind(k)) items.add(String(k));
  // Вид Материала — значение перечня material_kind: его знает только программа, а не programRequirements (BANK-63).
  const materialEnum = body.elements?.find((el) => el.kind === "enum" && el.code === "material_kind")?.id;
  for (const el of body.elements ?? []) {
    if (typeof el.kind === "string" && !(ELEMENT_KINDS as readonly string[]).includes(el.kind)) items.add(el.kind);
    const nc = el.props?.normClass;
    if (typeof nc === "string" && !isNormClass(nc)) items.add(nc);
    if (materialEnum !== undefined && el.kind === "enum_value" && el.props?.enum === materialEnum && !knownKind(el.code)) items.add(String(el.code));
  }
  return [...items].sort();
}

/** Содержимое версии против применённой (DICT-10, DICT-11, DICT-64, DICT-12, DICT-13, DICT-41, DICT-46). */
function checkContent(body: SlovarBody, prev: SlovarBody | undefined, localIds: ReadonlySet<string> = new Set()): void {
  const fail = (code: MessageCode, params: Record<string, string> = {}): never => {
    throw new Rejected("content", { detail: message(code, params) }, body.number);
  };
  const byId = new Map(body.elements.map((e) => [e.id, e]));
  if (byId.size !== body.elements.length) fail("content_id_repeat");
  for (const id of [...byId.keys(), ...body.stopLists.map((l) => l.id)]) if (localIds.has(id)) fail("content_local_id", { id });
  // Список Стоп-листа — элемент своего вида: Идентификатор и Код не повторяются (DICT-64).
  if (new Set(body.stopLists.map((l) => l.id)).size !== body.stopLists.length) fail("content_list_id_repeat");
  if (new Set(body.stopLists.map((l) => l.code)).size !== body.stopLists.length) fail("content_list_repeat");
  const codes = new Set<string>();
  for (const e of body.elements) {
    const key = e.kind === "enum_value" ? `${e.kind}:${String(e.props["enum"])}.${e.code}` : `${e.kind}:${e.code}`;
    if (codes.has(key)) fail("content_code_repeat", { code: e.code });
    codes.add(key);
    if (e.canonical !== undefined && !byId.has(e.canonical)) fail("content_canonical_missing", { code: e.code });
  }
  if (prev !== undefined) {
    const prevEnumCode = new Map(prev.elements.filter((e) => e.kind === "enum").map((e) => [e.id, e.code]));
    const now = new Map(body.elements.map((e) => [`${e.kind}:${e.kind === "enum_value" ? String(e.props["enum"]) + "." : ""}${e.code}`, e.id]));
    for (const p of prev.elements) {
      const cur = byId.get(p.id);
      if (cur === undefined) fail("content_element_gone", { code: p.code });
      else if (cur.kind !== p.kind) fail("content_kind_changed", { code: p.code });
      // Значение перечня не переходит в другой перечень (DICT-10, DICT-60; T183).
      else if (p.kind === "enum_value" && cur.props["enum"] !== p.props["enum"]) fail("content_enum_changed", { code: p.code });
      // «Поглощён» остаётся поглощённым, «устарел» не становится «действует» (DICT-12, DICT-13).
      else if ((p.state === "absorbed" && cur.state !== "absorbed") || (p.state === "deprecated" && cur.state === "active")) {
        fail("content_state_back", { code: p.code, from: p.state, to: cur.state });
      } else if (p.state === "absorbed" && cur.canonical !== p.canonical) fail("content_canonical_changed", { code: p.code });
      // Элементы и значения, которые программа находит по Коду, не перекодируются и не поглощаются
      // (DICT-60, BANK-63; T124, T146, T162).
      else if (
        (p.kind === "enum_value" ? programReadsByCode(prevEnumCode.get(String(p.props["enum"])) ?? "", p.code) : programReadsElement(p.kind, p.code)) &&
        (cur.code !== p.code || cur.state === "absorbed")
      ) {
        fail("content_program_code", { code: p.code });
      }
      // Синонимы перечня не пропадают: с ними прежние Коды значений читаются (DICT-10; T265).
      if (cur !== undefined && p.kind === "enum") {
        const now = (cur.props["aliases"] as Record<string, string> | undefined) ?? {};
        for (const alias of Object.keys((p.props["aliases"] as Record<string, string> | undefined) ?? {})) {
          if (!Object.hasOwn(now, alias)) fail("content_alias_gone", { enum: p.code, code: alias });
        }
      }
      // Значение сменило Код — прежний Код остаётся синонимом перечня, иначе Индикаторы с ним стали бы
      // «вне Словаря» (DICT-10; T259).
      if (cur !== undefined && p.kind === "enum_value" && cur.code !== p.code) {
        const aliases = (byId.get(String(cur.props["enum"]))?.props["aliases"] as Record<string, string> | undefined) ?? {};
        if (!Object.hasOwn(aliases, p.code)) fail("content_rename_alias_missing", { code: p.code });
      }
      const sameCode = now.get(`${p.kind}:${p.kind === "enum_value" ? String(p.props["enum"]) + "." : ""}${p.code}`);
      if (sameCode !== undefined && sameCode !== p.id) fail("content_id_changed", { code: p.code });
    }
    // Стоп-лист Сети едет в каждой версии целиком: список прежней версии не пропадает (DICT-46).
    const lists = new Set(body.stopLists.map((l) => l.id));
    for (const l of prev.stopLists) if (!lists.has(l.id)) fail("content_stop_list_gone", { list: l.code });
    // Код списка держит свой Идентификатор, как у элементов (DICT-10, DICT-64; T247).
    const listByCode = new Map(body.stopLists.map((l) => [l.code, l.id]));
    for (const l of prev.stopLists) {
      const id = listByCode.get(l.code);
      if (id !== undefined && id !== l.id) fail("content_id_changed", { code: l.code });
    }
  }
  // Один поглощённый — один канон: два разных канона одного элемента или местного типа — отказ (T232).
  const canonOfMerge = new Map<string, string>();
  for (const m of body.merges) {
    const key = "absorbed" in m ? m.absorbed : m.localId;
    if (canonOfMerge.has(key) && canonOfMerge.get(key) !== m.canonical) fail("content_merge_twice", { code: "absorbed" in m ? (byId.get(m.absorbed)?.code ?? key) : m.local });
    canonOfMerge.set(key, m.canonical);
  }
  for (const m of body.merges) {
    if (!byId.has(m.canonical)) fail("content_merge_missing");
    // Местный тип — тип Индикатора: склеивается только в тип Индикатора Сети (DICT-22).
    if ("local" in m && byId.get(m.canonical)?.kind !== "indicator_type") fail("content_merge_kind", { code: m.local });
    if (!("absorbed" in m)) continue;
    const absorbed = byId.get(m.absorbed);
    if (absorbed === undefined) fail("content_merge_missing");
    // Склейку делает состояние элемента: merges без «поглощён → канон» у элемента — расхождение (DICT-12).
    else if (absorbed.state !== "absorbed" || absorbed.canonical !== m.canonical) fail("content_merge_state", { code: absorbed.code });
  }
  // Поглощённый — того же вида, что канон, не сам в себя, без циклов; новое «поглощён» — с записью в
  // merges этой версии (DICT-12).
  const before = new Map((prev?.elements ?? []).map((e) => [e.id, e.state]));
  const merged = new Set(body.merges.filter((m) => "absorbed" in m).map((m) => (m as { absorbed: string }).absorbed));
  for (const e of body.elements) {
    if (e.state !== "absorbed" || e.canonical === undefined) continue;
    if (e.canonical === e.id) fail("content_merge_self", { code: e.code });
    // Синоним — между типами одного вида или значениями одного перечня; перечни не склеиваются.
    const canon = byId.get(e.canonical);
    if (canon?.kind !== e.kind || e.kind === "enum" || (e.kind === "enum_value" && canon.props["enum"] !== e.props["enum"])) fail("content_merge_kind", { code: e.code });
    // Вид объекта — с видом той же роли: узел — с узлом, часть Изделия — с частью (DATA-09, DATA-10; T199).
    else if (e.kind === "object_type" && canon.props["role"] !== e.props["role"]) fail("content_merge_role", { code: e.code });
    if (before.get(e.id) !== "absorbed" && !merged.has(e.id)) fail("content_absorbed_without_merge", { code: e.code });
  }
  const cycle = absorptionCycle(body.elements);
  if (cycle !== undefined) fail("content_merge_cycle", { code: cycle });
  // То, что программа находит по Коду, не приходит «поглощённым» — и в версии, где появилось впервые,
  // в том числе версии 1 (DICT-60; T179).
  const enumCode = new Map(body.elements.filter((e) => e.kind === "enum").map((e) => [e.id, e.code]));
  for (const e of body.elements) {
    if (e.state !== "absorbed") continue;
    const read = e.kind === "enum_value" ? programReadsByCode(enumCode.get(String(e.props["enum"])) ?? "", e.code) : programReadsElement(e.kind, e.code);
    if (read) fail("content_program_code", { code: e.code });
  }
  const normClass = new Map(body.elements.filter((e) => e.kind === "indicator_type").map((e) => [e.id, e.props["normClass"]]));
  // Класс строки — нынешний Класс канонического типа: тип мог быть поглощён не-ip типом (DICT-41; T182).
  const canonOf = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 64; i++) {
      const el = byId.get(cur);
      if (el === undefined || el.state !== "absorbed" || el.canonical === undefined) return cur;
      cur = el.canonical;
    }
    return cur;
  };
  const formatOfType = new Map(body.elements.filter((e) => e.kind === "indicator_type").map((e) => [e.id, e.props["format"]]));
  const applyFormatCtx = elementsFormatContext(body.elements);
  for (const list of body.stopLists) {
    const dup = new Set<string>();
    for (const [typeId, kind, value] of list.rows) {
      if (!normClass.has(typeId)) fail("content_stop_type_unknown", { list: list.code, type: typeId });
      // «Значение» проходит формат своего типа (приложение §8; T278).
      if (kind === "value" && stopValueBreaksFormat(formatOfType.get(typeId), value, applyFormatCtx)) fail("content_stop_format", { list: list.code, value });
      // «Значение» нормализуется Классом своего типа, строки не повторяются — как у сборки (T206).
      const cls = normClass.get(typeId) as string | null | undefined;
      let norm = trimSpace(value);
      if (kind === "value" && typeof cls === "string" && isNormClass(cls)) {
        const n = normalize(cls, value, { toAscii: domainToASCII });
        if (!n.ok) fail("content_stop_not_normalizable", { list: list.code, value, cls });
        else norm = n.value;
      }
      // Шаблон — в нормальной форме Класса, повтор — по ней, как у сборки (T258).
      if (kind === "pattern") {
        const nf = patternNormalForm(typeof cls === "string" && isNormClass(cls) ? cls : null, value, { toAscii: domainToASCII });
        if (nf === undefined) fail("content_stop_pattern_not_normal", { list: list.code, value, cls: String(cls) });
        else norm = nf;
      }
      const key = `${typeId}\u0000${kind}\u0000${norm}`;
      if (dup.has(key)) fail("content_stop_repeat", { list: list.code, type: typeId, value });
      dup.add(key);
      if (kind === "range" && normClass.get(canonOf(typeId)) !== "ip") fail("content_range_not_ip", { list: list.code, type: typeId });
      // Диапазон — разбираемый CIDR: иначе Стоп-лист не собрать и применение упало бы (DICT-41; T176).
      if (kind === "range" && parseCidr(trimSpace(value)) === undefined) fail("content_range_invalid", { list: list.code, value });
    }
  }
  // Класс и подтип шаблона — значения перечней item_class и item_subtype (T185).
  const enumIdByCode = new Map(body.elements.filter((e) => e.kind === "enum").map((e) => [e.code, e.id]));
  const valueOf = (id: unknown, enumCode: string) => {
    const el = typeof id === "string" ? byId.get(id) : undefined;
    return el?.kind === "enum_value" && el.props["enum"] === enumIdByCode.get(enumCode);
  };
  for (const tpl of body.templates) if (!valueOf(tpl.class, "item_class") || (tpl.subtype !== undefined && !valueOf(tpl.subtype, "item_subtype"))) fail("content_template_class_missing");
  // Шаблон — один на Класс и подтип (DATA-23; T217).
  const templateKeys = new Set<string>();
  for (const tpl of body.templates) {
    const key = `${tpl.class}:${tpl.subtype ?? ""}`;
    if (templateKeys.has(key)) fail("content_template_repeat", { class: key });
    templateKeys.add(key);
  }
  // Перечни полей программы — только закрытые (DICT-60; T204).
  for (const e of body.elements) if (e.kind === "enum" && (PROGRAM_ENUMS as readonly string[]).includes(e.code) && e.props["closed"] !== true) fail("content_program_enum_open", { code: e.code });
  // Закрыты только они: значение вне другого перечня — «вне Словаря», а не отказ (DICT-14, DICT-60; T300).
  for (const e of body.elements) if (e.kind === "enum" && !(PROGRAM_ENUMS as readonly string[]).includes(e.code) && e.props["closed"] === true) fail("content_enum_closed_not_program", { code: e.code });
  // Формат типа разбирается этой версией программы, перечень формата — в версии, как у сборки (T147, T206).
  for (const e of body.elements) {
    if (e.kind !== "indicator_type") continue;
    let format: ReturnType<typeof parseFormat> | undefined;
    try {
      format = parseFormat(String(e.props["format"]));
    } catch {
      fail("content_format_unknown", { code: e.code, format: String(e.props["format"]) });
    }
    if (format?.kind === "enum" && !enumIdByCode.has(format.enumCode)) fail("content_format_enum_missing", { code: e.code, enum: format.enumCode });
    // Перечень поля программы — не для типа Индикатора (DICT-14, DICT-60; T304).
    if (format?.kind === "enum" && (PROGRAM_ENUMS as readonly string[]).includes(format.enumCode)) fail("content_program_enum_format", { code: e.code, enum: format.enumCode });
  }
  // Ссылки на элементы — внутри версии: объект типа, опознающие, сравнение, концы связи, цели полей
  // шаблонов (DICT-10; T163). Особые знаки из PSEUDO_REFS — только там, где их допускает сборка: концы
  // связи, object типа Индикатора, objectKind поля шаблона (T172, T180).
  // Вид элемента — по месту ссылки, как у сборки (T185).
  const ofKind = (kind: string) => (id: unknown) => typeof id === "string" && byId.get(id)?.kind === kind;
  const orPseudo = (check: (id: unknown) => boolean) => (id: unknown) => check(id) || (typeof id === "string" && (PSEUDO_REFS as readonly string[]).includes(id));
  const indicatorRef = ofKind("indicator_type");
  const objectRef = orPseudo(ofKind("object_type"));
  const ids = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  for (const e of body.elements) {
    const ok =
      e.kind === "indicator_type"
        ? ids(e.props["object"]).every(objectRef) && ids(e.props["crossCompare"]).every(indicatorRef)
        : e.kind === "object_type"
          ? ids(e.props["identifying"]).every(indicatorRef)
          : e.kind === "link_type"
            ? [...ids(e.props["from"]), ...ids(e.props["to"])].every(objectRef)
            : e.kind === "enum_value"
              ? ofKind("enum")(e.props["enum"])
              : true;
    if (!ok) fail("content_ref_unknown", { key: `${e.kind}:${e.code}` });
  }
  for (const tpl of body.templates) {
    for (const block of tpl.blocks) {
      for (const f of block.fields) {
        const t = f.target as Record<string, unknown>;
        if (!ids(t["objectKind"]).every(objectRef) || !ids(t["indicatorTypes"]).every(indicatorRef) || !ids(t["link"]).every(ofKind("link_type"))) fail("content_ref_unknown", { key: f.label });
        // Формат поля шаблона — как формат типа (DATA-23; T248).
        if (f.format !== undefined) {
          let parsed: ReturnType<typeof parseFormat> | undefined;
          try {
            parsed = parseFormat(f.format);
          } catch {
            fail("content_format_unknown", { code: f.label, format: f.format });
          }
          if (parsed?.kind === "enum" && !enumIdByCode.has(parsed.enumCode)) fail("content_format_enum_missing", { code: f.label, enum: parsed.enumCode });
        }
      }
    }
  }
}

/** Склеенный версией тип для записи dictionary.apply (US6/AC6): Идентификаторы и Коды. */
interface MergedType {
  absorbed: string;
  absorbedCode: string;
  canonical: string;
  canonicalCode: string;
}

/** Типы Сети, ставшие поглощёнными этой версией (DICT-12): у предыдущей — не absorbed. */
function newSynonyms(body: SlovarBody, prev: SlovarBody | undefined): MergedType[] {
  const before = new Map((prev?.elements ?? []).map((e) => [e.id, e.state]));
  const code = new Map(body.elements.map((e) => [e.id, e.code]));
  return body.elements
    .filter((e) => e.state === "absorbed" && e.canonical !== undefined && before.get(e.id) !== "absorbed")
    .map((e) => ({ absorbed: e.id, absorbedCode: e.code, canonical: e.canonical!, canonicalCode: code.get(e.canonical!) ?? "" }));
}

/** Склейка местного типа своей Группы в тип Сети, названная в версии (DICT-22, DICT-23). */
function mergeLocalTypes(db: Db, body: SlovarBody, groupCode: string | undefined): MergedType[] {
  const merged: MergedType[] = [];
  const code = new Map(body.elements.map((e) => [e.id, e.code]));
  for (const m of body.merges) {
    if (!("local" in m) || groupCode === undefined || !m.local.startsWith(`${groupCode}:`)) continue;
    const res = db
      .prepare("UPDATE dict_element SET state = 'absorbed', canonicalId = ? WHERE level = 'local' AND id = ? AND code = ? AND state <> 'absorbed'")
      .run(m.canonical, m.localId, m.local);
    if (Number(res.changes) > 0) merged.push({ absorbed: m.localId, absorbedCode: m.local, canonical: m.canonical, canonicalCode: code.get(m.canonical) ?? "" });
  }
  return merged;
}

/**
 * Перечень сменил Код версией (DICT-10): формат местного типа «перечень:<Код>» переписывается на новый
 * Код — значения не становятся «вне Словаря» (T197). Типы Сети приходят с форматом в теле версии.
 */
function renameLocalEnumFormats(db: Db, body: SlovarBody, prev: SlovarBody | undefined): void {
  if (prev === undefined) return;
  const now = new Map(body.elements.filter((e) => e.kind === "enum").map((e) => [e.id, e.code]));
  const renamed = new Map<string, string>();
  for (const e of prev.elements) {
    const code = now.get(e.id);
    if (e.kind === "enum" && code !== undefined && code !== e.code) renamed.set(e.code, code);
  }
  if (renamed.size === 0) return;
  const update = db.prepare("UPDATE dict_element SET props = ? WHERE id = ?");
  for (const r of db.prepare("SELECT id, props FROM dict_element WHERE level = 'local' AND kind = 'indicator_type'").all()) {
    const props = JSON.parse(String(r["props"])) as Record<string, unknown>;
    const format = String(props["format"]);
    let parsed: ReturnType<typeof parseFormat>;
    try {
      parsed = parseFormat(format);
    } catch {
      continue;
    }
    const to = parsed.kind === "enum" ? renamed.get(parsed.enumCode) : undefined;
    const prefix = parsed.kind === "enum" ? `${FORMAT_NAMES.enum}:${parsed.enumCode}` : "";
    if (to === undefined || !format.startsWith(prefix)) continue;
    props["format"] = `${FORMAT_NAMES.enum}:${to}${format.slice(prefix.length)}`;
    update.run(JSON.stringify(props), String(r["id"]));
  }
}

/**
 * Местное значение перечня, чей Код занят значением Сети в том же перечне, поглощается значением Сети,
 * как местный тип склейкой (DICT-64, DICT-23; решение T211): Код в перечне снова один.
 */
function mergeLocalEnumValues(db: Db, body: SlovarBody): MergedType[] {
  const network = new Map(body.elements.filter((e) => e.kind === "enum_value").map((e) => [`${String(e.props["enum"])}\u0000${e.code}`, e]));
  const merged: MergedType[] = [];
  const absorb = db.prepare("UPDATE dict_element SET state = 'absorbed', canonicalId = ? WHERE id = ?");
  for (const r of db.prepare("SELECT id, code, props FROM dict_element WHERE level = 'local' AND kind = 'enum_value' AND state <> 'absorbed'").all()) {
    const props = JSON.parse(String(r["props"])) as Record<string, unknown>;
    const net = network.get(`${String(props["enum"])}\u0000${String(r["code"])}`);
    if (net === undefined) continue;
    absorb.run(net.id, String(r["id"]));
    merged.push({ absorbed: String(r["id"]), absorbedCode: String(r["code"]), canonical: net.id, canonicalCode: net.code });
  }
  return merged;
}

function ownGroupCode(db: Db): string | undefined {
  return registryState(db).current?.body.groups[0]?.code;
}

export function dictionaryState(db: Db): DictionaryCurrent | null {
  const row = db.prepare(`SELECT v.*, m.label AS byLabel FROM dictionary_version v LEFT JOIN member m ON m.id = v.appliedBy ORDER BY v.number DESC LIMIT 1`).get();
  if (row === undefined) return null;
  const signedBy = String(row["signedBy"]);
  return {
    number: Number(row["number"]),
    bodySha256: String(row["bodySha256"]),
    appliedAt: String(row["appliedAt"]),
    appliedBy: { id: row["appliedBy"] === null ? null : String(row["appliedBy"]), label: row["appliedBy"] === null ? message("actor_service") : String(row["byLabel"]) },
    signedBy: { key: signedBy, keyFingerprint: keyFingerprint(signedBy) },
  };
}

export function dictionaryDocumentText(db: Db, number: number): string | undefined {
  const row = db.prepare("SELECT document FROM dictionary_version WHERE number = ?").get(number);
  return row === undefined ? undefined : String(row["document"]);
}

/** POST /api/dictionary/versions. 201 — применена, 200 — та же версия уже применена. */
export function applyDictionaryVersion(db: Db, actor: DictionaryActor, text: string): { status: 200 | 201; current: DictionaryCurrent } {
  let actorId: string | null = "memberId" in actor ? actor.memberId : null;
  let number: number | undefined;
  let conflict: { by: string | null; hashes: string[] } | undefined;
  let applied: Record<string, number> | undefined;
  type Outcome = { kind: "applied" | "same" } | { kind: "rejected"; rejected: Rejected };
  let outcome: Outcome;
  try {
    outcome = inTransaction(db, (): Outcome => {
      if ("memberId" in actor) assertActor(db, actor.memberId, "dictionary.apply");
      let doc: SignedDocument;
      let raw: unknown;
      try {
        doc = parseSignedDocument(text, SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES });
        raw = JSON.parse(doc.body);
      } catch (error) {
        if (error instanceof SignedDocumentError || error instanceof SyntaxError) throw new Rejected("format");
        throw error;
      }
      // Порядок research R6: форма тела, номер и цепочка (тот же номер без подписи — signature до
      // conflict), подпись, требования к программе, схема, содержимое.
      // Схема тела проверяется после требований: неизвестный Класс — unsupported, а не format.
      if (!wellShaped(raw)) throw new Rejected("format");
      const rawNumber = (raw as { number?: unknown }).number;
      if (typeof rawNumber !== "number" || !Number.isInteger(rawNumber)) throw new Rejected("format");
      number = rawNumber;
      const hash = bodySha256(doc.body);
      const last = lastApplied(db);
      const known = last?.number ?? 0;
      // Подпись — Ключом Координатора из применённого Реестра Сети (DICT-17); до развилки: документ без
      // верной подписи — отказ signature, а не «другая версия с тем же номером».
      const registry = registryState(db).current;
      if (registry === null) throw new ApiError("network_not_launched");
      const signer = signerAmong(doc, registry.body.coordinatorKeys);
      // Автор — владелец проверенного ключа, как у Реестра, — сразу: и отказ, и конфликт от него (NET-54; T301).
      if ("bySignature" in actor && signer !== undefined) actorId = keyOwner(db, signer);
      if (last !== undefined && number === last.number) {
        if (hash === last.bodySha256) return { kind: "same" };
        if (signer === undefined) throw new Rejected("signature", {}, number);
        // Запись dictionary.conflict — после отката, вместе с отказом (Edge Cases spec.md).
        conflict = { by: actorId, hashes: [last.bodySha256, hash] };
        throw new Rejected("conflict", { number }, number);
      }
      if (number < known) throw new Rejected("stale", { number, known }, number);
      if (number > known + 1) throw new Rejected("gap", { number, expected: known + 1 }, number);
      const previousSha256 = (raw as { previousSha256?: unknown }).previousSha256;
      if (last !== undefined && previousSha256 !== last.bodySha256) throw new Rejected("chain", { number, known }, number);
      if (signer === undefined) throw new Rejected("signature", {}, number);
      const missing = unsupported(raw);
      if (missing.length > 0) throw new Rejected("unsupported", { items: missing.join(", ") }, number);
      let body: SlovarBody;
      try {
        body = parseSlovarBody(doc.body);
      } catch (error) {
        if (error instanceof SlovarFormatError) throw new Rejected("format", {}, number);
        throw error;
      }
      // Идентификаторы местных элементов и списка «Местное» этой Группы Сеть не занимает (DICT-22; T189).
      const localIds = new Set(
        db.prepare("SELECT id FROM dict_element WHERE level = 'local' UNION SELECT id FROM stop_list WHERE level = 'local'").all().map((r) => String(r["id"])),
      );
      checkContent(body, last?.body, localIds);

      const appliedAt = new Date().toISOString();
      db.prepare("INSERT INTO dictionary_version (number, document, bodySha256, signedBy, appliedAt, appliedBy) VALUES (?, ?, ?, ?, ?, ?)").run(
        body.number,
        serializeSignedDocument(doc),
        hash,
        signer,
        appliedAt,
        actorId,
      );
      // Словарь до версии — для шагов, которым важно, что изменилось (метка Секрет у типов, ставших
      // автоматическим Секретом, T205): снимок в памяти, материализация его не трогает.
      const before = currentDictionary(db);
      materialize(db, body);
      const localMerged = mergeLocalTypes(db, body, ownGroupCode(db));
      renameLocalEnumFormats(db, body, last?.body);
      const localValuesMerged = mergeLocalEnumValues(db, body);
      const synonyms = newSynonyms(body, last?.body);
      invalidateDictionary(db);
      const dictionary = currentDictionary(db)!;
      // Строки «Местного» версия не пересобирает: их нормализованная форма — по нынешнему Классу (DICT-41).
      const refresh = db.prepare("UPDATE stop_list_entry SET normalized = ? WHERE id = ? AND normalized <> ?");
      for (const r of db.prepare("SELECT e.id FROM stop_list_entry e JOIN stop_list l ON l.id = e.listId WHERE l.level = 'local'").all()) {
        const entry = dictionary.stopEntries.get(String(r["id"]));
        if (entry !== undefined) refresh.run(entry.normalized, entry.id, entry.normalized);
      }
      const counters: Record<string, number> = {
        synonyms: synonyms.length,
        localTypesMerged: localMerged.length,
        localValuesMerged: localValuesMerged.length,
        stopListRows: body.stopLists.reduce((n, l) => n + l.rows.length, 0),
      };
      for (const step of applySteps) Object.assign(counters, step(db, dictionary, body.number, actorId, before));
      applied = counters;
      journal(db, actorId, "dictionary.apply", body.number, {
        number: body.number,
        bodySha256: hash,
        signedBy: keyFingerprint(signer),
        ...counters,
        mergedTypes: [...synonyms, ...localMerged, ...localValuesMerged],
      });
      return { kind: "applied" };
    });
  } catch (error) {
    invalidateDictionary(db);
    if (!(error instanceof Rejected)) throw error;
    outcome = { kind: "rejected", rejected: error };
  }
  invalidateDictionary(db);
  if (outcome.kind === "rejected") {
    const r = outcome.rejected;
    inTransaction(db, () => {
      if (conflict !== undefined) journal(db, conflict.by, "dictionary.conflict", r.number, { number: r.number, bodySha256: conflict.hashes });
      const details: Record<string, unknown> = { reason: r.reason, ...r.params };
      journal(db, conflict?.by ?? actorId, "dictionary.reject", r.number ?? number, details);
    });
    throw rejectError(r);
  }
  const current = dictionaryState(db)!;
  if (outcome.kind === "applied") networkEvents.emit("dictionary-applied", current.number);
  return { status: outcome.kind === "applied" ? 201 : 200, current: applied === undefined ? current : { ...current, applied } };
}


