// Типы Записей модели данных (research R1, R2, R11 фичи 005; data-model.md «Записи предметной модели»):
// Кейс, Изделие, объект онтологии, связь, Индикатор — Записи механизма фичи 001 с ловушками: проверка
// по Словарю и полям программы (prepare), производное (derive), Кейс для журнала (caseOf), вид (view).
import { Type } from "typebox";
import { registerRecordType, type RecordContext, type RecordType } from "../bank/record-types.ts";
import { changeSecretInTx, getRecord, sameValue } from "../bank/records.ts";
import { canSeeRecord } from "../bank/visibility.ts";
import { caseAnswered } from "./case-view.ts";
import type { BankRecord } from "@aristotel/protocol";
import { bindCaseNumber, reserveCaseNumber } from "./case-number.ts";
import { Issues, enumValue, isMember, memberRole, recordFields, recordTypeOf, requireDictionary } from "./validate.ts";
import { caseLabel, recordLabel } from "./labels.ts";
import { isBlank, isStorageValue } from "./field-value.ts";
import { FORMAT_NAMES, checkFormat, parseFormat, PRINTABLE_TEXT } from "@aristotel/protocol";
import { domainToASCII } from "node:url";
import { ApiError } from "../api/errors.ts";
import type { Db } from "../db/open.ts";
import type { AppliedDictionary } from "../dictionary/current.ts";
import { registerApplyStep } from "../dictionary/apply.ts";
import { computeIndicatorValue, formatContext, readIndicatorValue, recomputeAll, stopListMark, writeIndicatorValue } from "./indicator-value.ts";

type Fields = Record<string, unknown>;
const Strict = { additionalProperties: false } as const;

/** Значение поля программы общей части Кейса: значение или состояние пустого поля (DATA-26). */
const ProgramValue = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object(
    {
      state: Type.Union([Type.Literal("not_established"), Type.Literal("absent"), Type.Literal("not_applicable")]),
      reason: Type.Optional(Type.String()),
    },
    Strict,
  ),
]);

/**
 * Одно правило пустого поля для полей программы и Индикаторов (DATA-26): причина — только у
 * «не установлено», у другого состояния снимается.
 */
function dropStaleReasons(fields: Fields, names: readonly string[]): void {
  for (const name of names) {
    const v = fields[name];
    if (typeof v === "object" && v !== null && !Array.isArray(v) && "reason" in v && (v as { state?: unknown }).state !== "not_established") {
      const { reason: _reason, ...rest } = v as Record<string, unknown>;
      fields[name] = rest;
    }
  }
}

/** Строка из пробелов в поле программы — не значение (DATA-26, Edge Cases). */
function checkNotBlank(issues: Issues, field: string, v: unknown): void {
  if (typeof v === "string" && isBlank(v)) issues.add(field, "format", "not_a_value");
}

/** Состояние пустого поля программы с обязательной причиной у «не установлено» (DATA-26). */
function checkEmptyState(issues: Issues, field: string, v: unknown): void {
  checkNotBlank(issues, field, v);
  if (typeof v !== "object" || v === null || (v as { state?: unknown }).state !== "not_established") return;
  const reason = (v as { reason?: unknown }).reason;
  if (!(typeof reason === "string" && !isBlank(reason))) issues.add(field, "reason");
}

/** Значение поля программы с закрытым перечнем: значение перечня или состояние пустого поля (DICT-60, DATA-26). */
function checkClosedProgramValue(issues: Issues, dict: AppliedDictionary, field: string, enumCode: string, v: unknown): void {
  if (v === undefined) return;
  if (typeof v === "string" && isBlank(v)) issues.add(field, "format", "not_a_value");
  else if (typeof v === "string") {
    if (enumValue(dict, enumCode, v) === undefined) issues.add(field, "closed");
  } else checkEmptyState(issues, field, v);
}

const CASE_STATUSES = ["draft", "in_review", "rework", "confirmed", "rejected"] as const;

const CaseFields = Type.Object(
  {
    number: Type.String({ pattern: "^\\d{4}-\\d{3,}$" }),
    status: Type.Union(CASE_STATUSES.map((s) => Type.Literal(s))),
    designation: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
    seizedAt: Type.Optional(ProgramValue),
    receivedAt: Type.Optional(ProgramValue),
    shape: Type.Optional(ProgramValue),
    performers: Type.Array(Type.String(), { minItems: 1 }),
    legacyId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    report: Type.Optional(Type.String()),
    seizureArea: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  Strict,
);

const ItemFields = Type.Object(
  {
    case: Type.String(),
    itemClass: Type.String(),
    itemSubtype: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    // null снимает признак: радиомодуль меняет Класс правкой (T212).
    onLinux: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  Strict,
);

/** Источник значения (DATA-28). */
/** Источники, чьё значение — «не проверено» до Проверки (DATA-29, AGENT-08). */
const UNVERIFIED_SOURCES: readonly string[] = ["auto", "agent"];

/** Указатель источника — непустая печатная строка: пустой указатель ни на что не указывает (DATA-28; T294). */
const Pointer = Type.String({ minLength: 1, pattern: PRINTABLE_TEXT });

export const Source = Type.Union([
  Type.Object({ kind: Type.Literal("auto"), parser: Pointer, file: Pointer }, Strict),
  Type.Object({ kind: Type.Literal("auto"), program: Pointer }, Strict),
  Type.Object({ kind: Type.Literal("manual") }, Strict),
  Type.Object({ kind: Type.Literal("agent"), client: Pointer, model: Pointer, version: Pointer, assignment: Pointer }, Strict),
  Type.Object({ kind: Type.Literal("import"), unit: Pointer }, Strict),
]);

const LinkFields = Type.Object(
  {
    type: Type.String(),
    from: Type.String(),
    to: Type.String(),
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    author: Type.String(),
    source: Source,
    // Причина правки человеком связи не ручного источника (DATA-30; T251).
    correction: Type.Optional(Type.Object({ reason: Type.String({ minLength: 1 }) }, Strict)),
    case: Type.String(),
  },
  Strict,
);

const formatCtx = { toAscii: domainToASCII, enumCodes: () => undefined, closedEnum: () => false };
const DATE_OR_RANGE = parseFormat(FORMAT_NAMES.datetime);

/** Дата поля общей части Кейса; range — можно ли диапазоном (DATA-15: дата изъятия — да, дата приёмки — нет). */
function checkProgramValue(issues: Issues, field: string, v: unknown, range: boolean): void {
  if (v === undefined) return;
  if (typeof v === "string" && isBlank(v)) issues.add(field, "format", "not_a_value");
  else if (typeof v === "string") {
    if (checkFormat(DATE_OR_RANGE, v, formatCtx) !== "ok" || (!range && v.includes("/"))) issues.add(field, "format");
  } else checkEmptyState(issues, field, v);
}

/** Объект онтологии вида code (по канону) — для полей, ссылающихся на объект определённого вида. */
function isObjectOfKind(ctx: RecordContext, dict: AppliedDictionary, id: unknown, code: string): boolean {
  if (recordTypeOf(ctx, id) !== "object") return false;
  const kind = recordFields(ctx, String(id))?.["kind"];
  const expected = dict.byCode("object_type", code);
  return expected !== undefined && typeof kind === "string" && dict.canonicalId(kind) === dict.canonicalId(expected.id);
}

function itemsOfCase(ctx: RecordContext, caseId: string): number {
  return Number(
    ctx.db.prepare("SELECT count(*) AS n FROM record_case rc JOIN record r ON r.id = rc.recordId WHERE rc.caseId = ? AND r.type = 'item'").get(caseId)?.["n"],
  );
}

/**
 * Кейсы, с которыми Запись связана через Изделия (правило R1, DATA-36): Кейс — сам; Изделие — свой Кейс;
 * связь и Индикатор — свой Кейс; часть Изделия — Кейс Изделия-владельца; узел — Кейсы Изделий, с
 * которыми его соединяют связи. Кейс, из которого заведён узел, сюда не входит: узел общий.
 */
export function casesOf(ctx: RecordContext, id: string): Set<string> {
  const type = recordTypeOf(ctx, id);
  if (type === "case") return new Set([id]);
  const fields = recordFields(ctx, id) ?? {};
  if (type === "item" || type === "link" || type === "indicator") return typeof fields["case"] === "string" ? new Set([fields["case"]]) : new Set();
  if (type !== "object") return new Set();
  if (typeof fields["item"] === "string") return casesOf(ctx, fields["item"]);
  const out = new Set<string>();
  const links = ctx.db
    .prepare("SELECT json_extract(fields, '$.from') AS f, json_extract(fields, '$.to') AS t FROM record WHERE type = 'link' AND (json_extract(fields, '$.from') = ? OR json_extract(fields, '$.to') = ?)")
    .all(id, id);
  for (const l of links) {
    const other = String(l["f"]) === id ? String(l["t"]) : String(l["f"]);
    // Часть Изделия — как её Изделие (DATA-36; T243).
    const otherType = recordTypeOf(ctx, other);
    if (otherType === "item" || (otherType === "object" && typeof recordFields(ctx, other)?.["item"] === "string")) for (const c of casesOf(ctx, other)) out.add(c);
  }
  return out;
}

/**
 * Кейсы Изделий и частей Изделий среди данных Записей: у них Кейс один — Кейс Изделия; общий узел
 * сюда не входит, его Индикатор и связь относят к Кейсу по выбору (DATA-36; T213).
 */
function ownedCases(ctx: RecordContext, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const type = recordTypeOf(ctx, id);
    if (type === "item" || (type === "object" && typeof recordFields(ctx, id)?.["item"] === "string")) for (const c of casesOf(ctx, id)) out.add(c);
  }
  return out;
}

/**
 * Правило R1 (data-model.md; DATA-36): Кейс из запроса; без него — единственный Кейс, с которым
 * участники связаны через Изделия; несколько или ни одного — 400 case_required.
 */
export function resolveCase(ctx: RecordContext, issues: Issues, explicit: unknown, related: string[]): string | undefined {
  if (explicit !== undefined) {
    if (recordTypeOf(ctx, explicit) !== "case") {
      issues.add("case", "kind");
      return undefined;
    }
    return String(explicit);
  }
  const cases = new Set<string>();
  for (const id of related) for (const c of casesOf(ctx, id)) cases.add(c);
  if (cases.size !== 1) throw new ApiError("case_required");
  return [...cases][0];
}

const caseType: RecordType = {
  name: "case",
  fields: CaseFields,
  // Исполнители Кейса в пакеты по Соглашениям не идут: партнёр видит только Код Группы (DATA-21).
  exchange: { performers: false },
  indexText: (f) => [f["number"], f["designation"], f["legacyId"]].filter((x) => typeof x === "string").join(" "),
  prepare: (ctx, input, previous) => {
    requireDictionary(ctx);
    const dict = ctx.dictionary!;
    const issues = new Issues();
    const fields: Fields = { ...input };
    if (previous === undefined) {
      if ("number" in input) issues.add("number", "immutable");
      if (fields["status"] !== undefined && fields["status"] !== "draft") issues.add("status", "status");
      fields["status"] = "draft";
      fields["performers"] ??= [ctx.authorId];
      fields["receivedAt"] ??= ctx.at.slice(0, 10);
    } else {
      const prev = previous.fields;
      if (fields["number"] !== prev["number"]) issues.add("number", "immutable");
      if (fields["status"] !== prev["status"]) issues.add("status", "status");
      if ((fields["legacyId"] ?? null) !== (prev["legacyId"] ?? null)) issues.add("legacyId", "create_only");
    }
    dropStaleReasons(fields, ["seizedAt", "receivedAt", "shape"]);
    checkClosedProgramValue(issues, dict, "shape", "case_shape", fields["shape"]);
    // Исполнители — Участники и Старшие, не Наблюдатель (DATA-19); проверяются, когда меняются: ставший
    // Наблюдателем исполнитель правку Кейса не блокирует.
    const performers = fields["performers"];
    if (performers !== undefined && !Array.isArray(performers)) issues.add("performers", "field");
    else if (previous === undefined || !sameValue(performers, previous.fields["performers"])) {
      for (const p of (performers as unknown[] | undefined) ?? []) {
        if (!isMember(ctx, p)) issues.add("performers", "member");
        else if (memberRole(ctx, p) === "observer") issues.add("performers", "observer");
      }
    }
    checkProgramValue(issues, "seizedAt", fields["seizedAt"], true);
    checkProgramValue(issues, "receivedAt", fields["receivedAt"], false);
    // Район изъятия — Гео-объект; точность — в его значении формата «гео» (DATA-16, приложение §5).
    const area = fields["seizureArea"];
    if (area !== undefined && area !== null && !isObjectOfKind(ctx, dict, area, "geo_object")) issues.add("seizureArea", "kind");
    if (previous !== undefined && enumValue(dict, "case_shape", fields["shape"])?.code === "single_item" && itemsOfCase(ctx, previous.id) > 1) {
      issues.add("shape", "single_item");
    }
    issues.throwIfAny();
    if (previous === undefined) fields["number"] = reserveCaseNumber(ctx.db, ctx.at);
    return { fields };
  },
  derive: (ctx, record) => {
    bindCaseNumber(ctx.db, String(record.fields["number"]), record.id);
    ctx.db.prepare("INSERT OR REPLACE INTO record_case (recordId, caseId) VALUES (?, ?)").run(record.id, record.id);
  },
  caseOf: (_ctx, record) => record.id,
  // «Отвечено» — одно с GET /api/cases/:id: общая часть и поля видимых читающему Изделий (DATA-27; T297).
  view: (ctx, record, reader) => {
    const items = ctx.db
      .prepare("SELECT r.id FROM record_case rc JOIN record r ON r.id = rc.recordId WHERE rc.caseId = ? AND r.type = 'item' ORDER BY r.createdAt, r.id")
      .all(record.id)
      .map((r) => getRecord(ctx.db, String(r["id"])))
      .filter((r): r is BankRecord => r !== undefined && canSeeRecord(reader, r.secret));
    return { label: caseLabel(String(record.fields["number"]), undefined, ctx.dictionary?.groupCode), answered: caseAnswered(ctx.db, record, items, reader) };
  },
};

const itemType: RecordType = {
  name: "item",
  fields: ItemFields,
  indexText: () => "",
  prepare: (ctx, input, previous) => {
    const dict = requireDictionary(ctx);
    const issues = new Issues();
    const fields: Fields = { ...input };
    if (previous !== undefined && fields["case"] !== previous.fields["case"]) issues.add("case", "immutable");
    if (recordTypeOf(ctx, fields["case"]) !== "case") issues.add("case", "kind");
    const cls = enumValue(dict, "item_class", fields["itemClass"]);
    if (cls === undefined) issues.add("itemClass", "closed");
    const sub = fields["itemSubtype"];
    if (sub !== undefined && sub !== null) {
      if (enumValue(dict, "item_subtype", sub) === undefined) issues.add("itemSubtype", "closed");
      else if (cls !== undefined && dict.templates(cls.id, String(sub)).length === 0) issues.add("itemSubtype", "kind");
    }
    if (fields["onLinux"] === null) delete fields["onLinux"];
    if (fields["onLinux"] !== undefined && cls?.code !== "radio_module") issues.add("onLinux", "kind");
    if (previous === undefined && issues.list.length === 0) {
      const caseFields = recordFields(ctx, String(fields["case"]))!;
      if (enumValue(dict, "case_shape", caseFields["shape"])?.code === "single_item" && itemsOfCase(ctx, String(fields["case"])) >= 1) issues.add("case", "single_item");
    }
    issues.throwIfAny();
    return { fields };
  },
  derive: (ctx, record) => {
    ctx.db.prepare("INSERT OR REPLACE INTO record_case (recordId, caseId) VALUES (?, ?)").run(record.id, String(record.fields["case"]));
  },
  caseOf: (_ctx, record) => String(record.fields["case"]),
  view: (ctx, record, reader) => ({ label: recordLabel(ctx.db, ctx.dictionary, record.id, reader) }),
};

/** Вид Записи для правила «Между» связи (DATA-11; приложение §2): Изделие, узел или часть, связь. */
function endKinds(ctx: RecordContext, id: string): string[] {
  const type = recordTypeOf(ctx, id);
  if (type === "item") return ["@item"];
  if (type === "link") return ["@link"];
  // Связь «подтверждается» ведёт к Артефакту или прямо к Материалу (DATA-12; фича 006).
  if (type === "material") return ["@material"];
  if (type === "object") {
    // Вид объекта — по канону: после склейки вида связь читается через канонический вид (DICT-12; T191).
    const dict = ctx.dictionary;
    const raw = String(recordFields(ctx, id)?.["kind"]);
    const kind = dict === undefined ? raw : dict.canonicalId(raw);
    const role = dict?.element(kind)?.props["role"];
    return [kind, role === "node" ? "@node" : "@part"];
  }
  return [];
}

const linkType: RecordType = {
  name: "link",
  fields: LinkFields,
  indexText: () => "",
  prepare: (ctx, input, previous) => {
    const dict = requireDictionary(ctx);
    const issues = new Issues();
    const fields: Fields = { ...input };
    fields["author"] ??= ctx.authorId;
    const type = typeof fields["type"] === "string" ? dict.element(fields["type"]) : undefined;
    if (type === undefined || type.kind !== "link_type") issues.add("type", "unknown");
    // Устарел сам тип или его канон — новых связей нет (DICT-13 вместе с DICT-12; T192).
    // Правка на устаревший тип — тоже новая связь этого типа (T207).
    else if ((previous === undefined || fields["type"] !== previous.fields["type"]) && (type.state === "deprecated" || dict.element(dict.canonicalId(type.id))?.state === "deprecated")) {
      issues.add("type", "deprecated");
    }
    // Концы — Идентификаторы-строки; другой вид — нарушение «Между», а не сбой (T178).
    const from = typeof fields["from"] === "string" ? fields["from"] : "";
    const to = typeof fields["to"] === "string" ? fields["to"] : "";
    // «Между» — при создании и при смене типа: прежнюю связь версия, сменившая «Между», править не мешает
    // (DICT-13; T246). Концы правкой не меняются.
    if (type !== undefined && type.kind === "link_type" && (previous === undefined || fields["type"] !== previous.fields["type"])) {
      // «Между» сравнивается по канону с обеих сторон (DICT-12; T191).
      const canon = (k: string) => (k.startsWith("@") ? k : dict.canonicalId(k));
      const allowed = (side: unknown, id: string) => endKinds(ctx, id).some((k) => (side as string[]).some((s) => canon(s) === canon(k)));
      // «Между» и направленность — у канонического типа связи, как свойства типа Индикатора (T196).
      const p = (dict.element(dict.canonicalId(type.id)) ?? type).props;
      const forward = allowed(p["from"], from) && allowed(p["to"], to);
      const backward = p["directed"] === false && allowed(p["from"], to) && allowed(p["to"], from);
      if (!forward && !backward) issues.add("to", "ends");
      // Часть принадлежит одному Изделию: связь Изделия с частью чужого Изделия — нарушение (DATA-10; T299).
      const itemOf = (id: string) => (recordTypeOf(ctx, id) === "object" ? recordFields(ctx, id)?.["item"] : undefined);
      for (const [a, b] of [[from, to], [to, from]] as const) {
        const owner = itemOf(b);
        if (recordTypeOf(ctx, a) === "item" && typeof owner === "string" && owner !== a) issues.add("to", "kind");
      }
    }
    // Автор — действующий Член Группы при создании; отозванный автор прежней связи её правку не блокирует (T252).
    if (previous === undefined && !isMember(ctx, fields["author"])) issues.add("author", "member");
    if (previous !== undefined && (fields["from"] !== previous.fields["from"] || fields["to"] !== previous.fields["to"])) issues.add("to", "immutable");
    // Источник после создания ставит программа, как у Индикатора; автор связи правкой не меняется
    // (DATA-11, DATA-28, contracts/http-api.md; T226).
    if (previous !== undefined && !sameValue(fields["source"], previous.fields["source"])) issues.add("source", "server");
    if (previous !== undefined && fields["author"] !== previous.fields["author"]) issues.add("author", "immutable");
    // Правка человеком связи «авто», «агента» или «импорта» — как у Индикатора: с причиной, источник
    // становится «вручную» (DATA-28, DATA-30, AGENT-08; T251).
    const correctionSent = previous === undefined ? "correction" in input : !sameValue(fields["correction"], previous.fields["correction"]);
    let humanEdit = false;
    if (previous === undefined) {
      if (correctionSent) issues.add("correction", "kind");
    } else {
      const prevKind = (previous.fields["source"] as { kind?: string } | undefined)?.kind;
      const notManual = prevKind === "auto" || prevKind === "agent" || prevKind === "import";
      const edited = (["type", "confidence"] as const).some((f) => !sameValue(fields[f], previous.fields[f]));
      if (notManual && edited) {
        humanEdit = true;
        const reason = (fields["correction"] as { reason?: unknown } | undefined)?.reason;
        if (!correctionSent || typeof reason !== "string" || isBlank(reason)) issues.add("correction", "reason");
      } else if (correctionSent) issues.add("correction", "kind");
    }
    issues.throwIfAny();
    if (humanEdit) fields["source"] = { kind: "manual" };
    // Связь идёт от Изделия или его части — её Кейс — Кейс этого Изделия; иначе — по участникам
    // (DATA-36; T227).
    const ownedEnds = [from, to].filter((id) => ownedCases(ctx, [id]).size > 0);
    if (previous !== undefined) {
      if (fields["case"] !== previous.fields["case"]) issues.add("case", "immutable");
    } else if (fields["case"] === undefined) fields["case"] = resolveCase(ctx, issues, undefined, ownedEnds.length > 0 ? ownedEnds : [from, to]);
    else {
      resolveCase(ctx, issues, fields["case"], []);
      // Конец — Изделие или его часть: Кейс выбирается только среди их Кейсов, как у части (DATA-36; T213).
      const owned = ownedCases(ctx, [from, to]);
      // case не строкой — нарушение вида, а не сбой приведения (T178; T255).
      if (owned.size > 0 && (typeof fields["case"] !== "string" || !owned.has(fields["case"]))) issues.add("case", "kind");
    }
    issues.throwIfAny();
    return { fields };
  },
  derive: (ctx, record) => {
    ctx.db.prepare("INSERT OR REPLACE INTO record_case (recordId, caseId) VALUES (?, ?)").run(record.id, String(record.fields["case"]));
  },
  caseOf: (_ctx, record) => String(record.fields["case"]),
  // «Авто» и «агент» — «не проверено» до Проверки, как у Индикатора (AGENT-08, DATA-29; T237).
  view: (ctx, record, reader) => ({
    label: recordLabel(ctx.db, ctx.dictionary, record.id, reader),
    typeFromNewerVersion: typeFromNewer(ctx.dictionary, record, "type"),
    marks: UNVERIFIED_SOURCES.includes(String((record.fields["source"] as { kind?: unknown } | undefined)?.kind)) ? ["unverified"] : [],
  }),
};

/** Поля программы блока «Носитель» — у Аппаратного элемента (DATA-13, INTAKE-04; приложение §9). */
const MEDIA_FIELDS = ["acquisitionMethod", "acquisitionTool", "intakeStation", "extractionStatus"] as const;

const ObjectFields = Type.Object(
  {
    kind: Type.String(),
    item: Type.Optional(Type.String()),
    case: Type.String(),
    // Поля программы блока «Носитель» (DATA-13; INTAKE-04): у Аппаратного элемента-носителя; значение
    // или состояние пустого поля (DATA-26).
    acquisitionMethod: Type.Optional(ProgramValue),
    acquisitionTool: Type.Optional(ProgramValue),
    intakeStation: Type.Optional(ProgramValue),
    extractionStatus: Type.Optional(ProgramValue),
  },
  Strict,
);

const objectType: RecordType = {
  name: "object",
  fields: ObjectFields,
  indexText: () => "",
  prepare: (ctx, input, previous) => {
    const dict = requireDictionary(ctx);
    const issues = new Issues();
    const fields: Fields = { ...input };
    const kind = typeof fields["kind"] === "string" ? dict.element(fields["kind"]) : undefined;
    if (kind === undefined || kind.kind !== "object_type") issues.add("kind", "unknown");
    else if (previous === undefined && (kind.state === "deprecated" || dict.element(dict.canonicalId(kind.id))?.state === "deprecated")) issues.add("kind", "deprecated");
    if (previous !== undefined && (fields["kind"] !== previous.fields["kind"] || fields["item"] !== previous.fields["item"])) issues.add("kind", "immutable");
    // Часть Изделия принадлежит одному Изделию (DATA-10); узел с Изделием связывает связь (DATA-09).
    if (kind?.props["role"] === "part") {
      if (recordTypeOf(ctx, fields["item"]) !== "item") issues.add("item", "required");
    } else if (fields["item"] !== undefined) issues.add("item", "kind");
    // Носитель — Аппаратный элемент; уже названный другим видом (hw_kind ≠ storage) полей «Носителя» не несёт.
    const media = MEDIA_FIELDS.filter((f) => fields[f] !== undefined);
    if (media.length > 0 && kind !== undefined && (!isObjectKind(dict, kind.id, "hw_element") || (previous !== undefined && hwKindOtherThanStorage(ctx, dict, previous.id)))) {
      for (const f of media) issues.add(f, "kind");
    }
    dropStaleReasons(fields, MEDIA_FIELDS);
    checkClosedProgramValue(issues, dict, "acquisitionMethod", "acquisition_method", fields["acquisitionMethod"]);
    checkClosedProgramValue(issues, dict, "extractionStatus", "extraction_status", fields["extractionStatus"]);
    checkEmptyState(issues, "acquisitionTool", fields["acquisitionTool"]);
    checkEmptyState(issues, "intakeStation", fields["intakeStation"]);
    issues.throwIfAny();
    if (previous === undefined) {
      // Часть Изделия — в Кейсе своего Изделия; узел — Кейс из запроса или 400 case_required (DATA-36).
      const item = fields["item"];
      // Часть Изделия — в Кейсе своего Изделия: другой явный Кейс — отказ (DATA-10, DATA-36).
      if (typeof item === "string" && fields["case"] !== undefined && fields["case"] !== recordFields(ctx, item)?.["case"]) issues.add("case", "kind");
      issues.throwIfAny();
      fields["case"] = resolveCase(ctx, issues, fields["case"], typeof item === "string" ? [item] : []);
      issues.throwIfAny();
    } else if (fields["case"] !== previous.fields["case"]) issues.add("case", "immutable");
    issues.throwIfAny();
    return { fields };
  },
  derive: (ctx, record) => {
    ctx.db.prepare("INSERT OR REPLACE INTO record_case (recordId, caseId) VALUES (?, ?)").run(record.id, String(record.fields["case"]));
  },
  caseOf: (_ctx, record) => String(record.fields["case"]),
  view: (ctx, record, reader) => ({ label: recordLabel(ctx.db, ctx.dictionary, record.id, reader), typeFromNewerVersion: typeFromNewer(ctx.dictionary, record, "kind") }),
};

function isObjectKind(dict: AppliedDictionary, kindId: string, code: string): boolean {
  const expected = dict.byCode("object_type", code);
  return expected !== undefined && dict.canonicalId(kindId) === dict.canonicalId(expected.id);
}

/** У Аппаратного элемента есть Индикатор hw_kind со значением не storage — он не носитель (приложение §9). */
function hwKindOtherThanStorage(ctx: RecordContext, dict: AppliedDictionary, objectId: string): boolean {
  const hwKind = dict.byCode("indicator_type", "hw_kind");
  if (hwKind === undefined) return false;
  return ctx.db
    .prepare("SELECT fields FROM record WHERE type = 'indicator' AND json_extract(fields, '$.object') = ?")
    .all(objectId)
    .map((r) => JSON.parse(String(r["fields"])) as Record<string, unknown>)
    .some((f) => dict.canonicalId(String(f["type"])) === dict.canonicalId(hwKind.id) && typeof f["value"] === "string" && !isStorageValue(f["value"]));
}

const IndicatorFields = Type.Object(
  {
    object: Type.String(),
    type: Type.String(),
    value: Type.Optional(Type.String()),
    state: Type.Optional(Type.Union([Type.Literal("not_established"), Type.Literal("absent"), Type.Literal("not_applicable")])),
    reason: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    source: Source,
    verified: Type.Boolean(),
    correction: Type.Optional(Type.Object({ reason: Type.String({ minLength: 1 }) }, Strict)),
    /** Исходное значение «авто» после ручной правки — рядом с исправленным для Проверки (DATA-30). */
    autoValue: Type.Optional(Type.String()),
    /** Исходное состояние пустого поля «авто» после ручной правки (DATA-30). */
    autoState: Type.Optional(
      Type.Object(
        { state: Type.Union([Type.Literal("not_established"), Type.Literal("absent"), Type.Literal("not_applicable")]), reason: Type.Optional(Type.String()) },
        Strict,
      ),
    ),
    case: Type.String(),
  },
  Strict,
);

const indicatorType: RecordType = {
  name: "indicator",
  fields: IndicatorFields,
  indexText: (f) => (typeof f["value"] === "string" ? f["value"] : ""),
  prepare: (ctx, input, previous) => {
    const dict = requireDictionary(ctx);
    const issues = new Issues();
    const fields: Fields = { ...input };
    // verified и исходное значение «авто» ставит программа (DATA-29, DATA-30); снимать «не проверено»
    // будет Проверка (фича 010).
    // Источник после создания тоже ставит программа: правка «авто» переводит его в «вручную» (DATA-30).
    const SERVER_FIELDS = ["verified", "autoValue", "autoState"] as const;
    if (previous === undefined) {
      for (const f of SERVER_FIELDS) if (f in input) issues.add(f, "server");
      if ("correction" in input) issues.add("correction", "kind");
    } else {
      for (const f of SERVER_FIELDS) if (!sameValue(fields[f], previous.fields[f])) issues.add(f, "server");
      if (!sameValue(fields["source"], previous.fields["source"])) issues.add("source", "server");
      // Правка меняет значение на состояние пустого поля или обратно: новое вытесняет прежнее (DATA-26).
      if (fields["value"] !== undefined && fields["state"] !== undefined) {
        const valueNew = fields["value"] !== previous.fields["value"];
        const stateNew = fields["state"] !== previous.fields["state"];
        if (valueNew && !stateNew) {
          delete fields["state"];
          delete fields["reason"];
        } else if (stateNew && !valueNew) delete fields["value"];
      }
    }
    const type = typeof fields["type"] === "string" ? dict.element(fields["type"]) : undefined;
    const props = type === undefined ? undefined : dict.indicatorType(type.id);
    if (type === undefined || props === undefined) issues.add("type", "unknown");
    if (previous !== undefined && (fields["type"] !== previous.fields["type"] || fields["object"] !== previous.fields["object"])) issues.add("type", "immutable");
    // Устаревший тип — новых значений нет, старые читаются (DICT-13).
    // Новым значением считается только новое значение: снять его (перейти в состояние) — не новое (T263).
    const valueChanged = previous === undefined || (fields["value"] !== undefined && fields["value"] !== previous.fields["value"]);
    if (type !== undefined && dict.element(dict.canonicalId(type.id))?.state === "deprecated" && valueChanged) issues.add("type", "deprecated");
    // Объект Индикатора — того вида, что у типа (приложение §6): объект онтологии или Изделие (@item).
    const objectType = recordTypeOf(ctx, fields["object"]);
    const expected = props?.object;
    const objectId = typeof fields["object"] === "string" ? fields["object"] : "";
    const objectKind = objectType === "object" ? recordFields(ctx, objectId)?.["kind"] : objectType === "item" ? "@item" : undefined;
    // Вид объекта — при создании: тип и объект правкой не меняются, а прежний Индикатор после версии,
    // сменившей object типа, правится (DICT-13; T246).
    if (previous === undefined && objectKind === undefined) issues.add("object", "kind");
    else if (previous === undefined && expected !== undefined && dict.canonicalId(String(objectKind)) !== dict.canonicalId(expected) && objectKind !== expected) issues.add("object", "kind");
    // Элемент с полями «Носителя» не называется не носителем: hw_kind ≠ storage — отказ (решение T150).
    const hwKind = dict.byCode("indicator_type", "hw_kind");
    if (hwKind !== undefined && type !== undefined && dict.canonicalId(type.id) === dict.canonicalId(hwKind.id) && typeof fields["value"] === "string" && !isStorageValue(fields["value"])) {
      const objectFields = recordFields(ctx, objectId) ?? {};
      if (MEDIA_FIELDS.some((f) => objectFields[f] !== undefined)) issues.add("value", "kind");
    }
    // Значение или состояние пустого поля (DATA-25, DATA-26).
    const value = fields["value"];
    if (typeof value === "string" && isBlank(value)) issues.add("value", "format", "not_a_value");
    // Значение вне закрытого перечня не принимается (DICT-60); у открытого — метка «вне Словаря» (DICT-14).
    if (typeof value === "string" && valueChanged && props !== undefined) {
      try {
        if (checkFormat(parseFormat(props.format), value, formatContext(dict)) === "closed_violation") issues.add("value", "closed");
      } catch {
        // Формат не разобран — метка format_violation в производном.
      }
    }
    if (value !== undefined && fields["state"] !== undefined) issues.add("state", "kind");
    // Причина — только у «не установлено»: с другим состоянием или значением она снимается (DATA-26).
    if (fields["state"] !== "not_established") delete fields["reason"];
    if (fields["state"] === "not_established" && !(typeof fields["reason"] === "string" && !isBlank(fields["reason"]))) issues.add("reason", "reason");
    // Источник «авто» и «агент» — «не проверено» до Проверки (DATA-29, AGENT-08; T222); ручная правка
    // «авто» — с причиной (DATA-30).
    const prevSource = previous?.fields["source"] as { kind?: string } | undefined;
    if (previous === undefined) fields["verified"] = !UNVERIFIED_SOURCES.includes(String((fields["source"] as { kind?: string } | undefined)?.kind));
    else {
      // Тот же correction, отправленный снова (GET → PATCH), — не новая правка (сравнение по значению).
      const correctionSent = !sameValue(fields["correction"], previous.fields["correction"]);
      // Правка человеком значения не ручного источника — «авто», «агент», «импорт» — значение, состояние
      // или причина «не установлено» (DATA-28, DATA-30; решение T151).
      const notManual = prevSource?.kind === "auto" || prevSource?.kind === "agent" || prevSource?.kind === "import";
      const edited = fields["value"] !== previous.fields["value"] || fields["state"] !== previous.fields["state"] || fields["reason"] !== previous.fields["reason"];
      if (notManual && edited) {
        // Причина обязательна, исходное — рядом для Проверки (DATA-30); исправленное проверено
        // человеком (решение T133).
        // Причина — непустая строка; другой вид — нарушение, а не сбой (T170).
        const reason = (fields["correction"] as { reason?: unknown } | undefined)?.reason;
        if (!correctionSent || typeof reason !== "string" || isBlank(reason)) issues.add("correction", "reason");
        if (previous.fields["value"] !== undefined) fields["autoValue"] = previous.fields["autoValue"] ?? previous.fields["value"];
        else if (previous.fields["state"] !== undefined) {
          const reason = previous.fields["reason"];
          fields["autoState"] = previous.fields["autoState"] ?? { state: previous.fields["state"], ...(typeof reason === "string" ? { reason } : {}) };
        }
        fields["source"] = { kind: "manual" };
        fields["verified"] = true;
      } else if (correctionSent) issues.add("correction", "kind");
    }
    issues.throwIfAny();
    if (previous === undefined) {
      // Индикатор Изделия или его части — в Кейсе Изделия: другой явный Кейс — отказ (DATA-36; T213).
      const owned = ownedCases(ctx, [objectId]);
      if (fields["case"] !== undefined && owned.size > 0 && (typeof fields["case"] !== "string" || !owned.has(fields["case"]))) issues.add("case", "kind");
      issues.throwIfAny();
      fields["case"] = resolveCase(ctx, issues, fields["case"], [objectId]);
    } else if (fields["case"] !== previous.fields["case"]) issues.add("case", "immutable");
    issues.throwIfAny();
    // Автоматический Секрет по типу — Словарь Сети или Местное расширение (ROLE-25).
    return { fields, secret: previous === undefined && props?.autoSecret === true };
  },
  derive: (ctx, record) => {
    ctx.db.prepare("INSERT OR REPLACE INTO record_case (recordId, caseId) VALUES (?, ?)").run(record.id, String(record.fields["case"]));
    if (ctx.dictionary !== undefined) writeIndicatorValue(ctx.db, record.id, computeIndicatorValue(ctx.dictionary, record.fields));
  },
  caseOf: (_ctx, record) => String(record.fields["case"]),
  view: (ctx, record, reader) => {
    const dict = ctx.dictionary;
    const v = readIndicatorValue(ctx.db, record.id) ?? (dict === undefined ? undefined : computeIndicatorValue(dict, record.fields));
    return {
      label: recordLabel(ctx.db, dict, record.id, reader),
      canonicalType: v?.canonicalTypeId ?? record.fields["type"],
      normalized: v?.normalized ?? null,
      marks: v?.flags ?? [],
      stopList: dict === undefined ? null : stopListMark(dict, v?.stopListEntryId ?? null),
      identifying: v?.identifying ?? false,
      autoValue: record.fields["autoValue"] ?? null,
      autoState: record.fields["autoState"] ?? null,
      typeFromNewerVersion: typeFromNewer(dict, record, "type"),
    };
  },
};

/**
 * Тип из более новой версии Словаря в копии (DICT-20): тип Индикатора или связи, вид объекта (field).
 * Своих Записей это не касается — копии в фиче 022.
 */
function typeFromNewer(dict: AppliedDictionary | undefined, record: { fields: Fields }, field: "type" | "kind"): { version: number; known: number } | null {
  if (dict === undefined || dict.element(String(record.fields[field])) !== undefined) return null;
  const version = Number((record.fields as { dictionaryVersion?: unknown }).dictionaryVersion);
  return Number.isInteger(version) ? { version, known: dict.version } : null;
}

/**
 * Шаг применения версии Словаря (research R6, шаг 8): пересчёт производного всех Индикаторов и метка
 * Секрет на Индикаторах типов, ставших автоматическим Секретом (ROLE-25, DICT-18, DICT-46).
 */
export function recomputeOnApply(db: Db, dict: AppliedDictionary, _number: number, actorId: string | null, previous?: AppliedDictionary): Record<string, number> {
  const counters = recomputeAll(db, dict);
  const secretMarked = markAutoSecret(db, dict, actorId, previous);
  return { stopListGained: counters.stopListGained, stopListLost: counters.stopListLost, secretMarked };
}

/**
 * Метка Секрет на Индикаторах типов, ставших автоматическим Секретом (ROLE-25) — общей операцией метки
 * (changeSecretInTx). Тип, бывший автоматическим Секретом и в previous, метку не ставит заново: снятая
 * по ROLE-18 метка не возвращается (T205). Автор — кто применил версию или принял ужесточение; если его
 * нет (версию принёс Ретранслятор), — автор Записи, а журнал — от службы.
 */
export function markAutoSecret(db: Db, dict: AppliedDictionary, actorId: string | null, previous: AppliedDictionary | undefined): number {
  let secretMarked = 0;
  for (const row of db.prepare("SELECT id FROM record WHERE type = 'indicator' AND secret = 0").all()) {
    const record = getRecord(db, String(row["id"]))!;
    const type = String(record.fields["type"]);
    if (dict.indicatorType(type)?.autoSecret !== true || previous?.indicatorType(type)?.autoSecret === true) continue;
    if (changeSecretInTx(db, record, true, actorId ?? record.createdBy, actorId, { reason: "auto-secret" })) secretMarked++;
  }
  return secretMarked;
}

const MODEL_TYPES: RecordType[] = [caseType, itemType, linkType, objectType, indicatorType];

/** Зарегистрировать типы модели — при сборке приложения службы (идемпотентно). */
export function registerModelTypes(extra: RecordType[] = []): void {
  for (const type of [...MODEL_TYPES, ...extra]) registerRecordType(type);
  registerApplyStep(recomputeOnApply);
}
