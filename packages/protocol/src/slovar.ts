// Документ версии Словаря Сети aristotel/slovar/v1 и файл списка Стоп-листа aristotel/stop-list/v1
// (contracts/slovar-v1.md; research R4, R5 фичи 005; DICT-02, DICT-09 … DICT-13, DICT-16, DICT-41, DICT-42).
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { message } from "./messages.ts";
import { describeIssues, type SchemaIssue } from "./validation.ts";
import { isoInstant } from "./formats.ts";

export const SLOVAR_FORMAT = "aristotel/slovar/v1";
export const STOP_LIST_FILE_FORMAT = "aristotel/stop-list/v1";

/**
 * Виды Материала, которые знает эта версия программы: перечень `material_kind` приложения §7.
 * Новый вид — только новой версией программы (BANK-63, DICT-60); что с видом делать — фича 006.
 */
export const MATERIAL_KINDS = ["image", "logical_copy", "extracted_file", "photo", "crypto_task", "legacy_file", "external_source"] as const;

/**
 * Закрытые перечни полей программы (DICT-60): программа находит их по Коду, поэтому Код у них не
 * меняется ни сборкой, ни версией.
 */
export const PROGRAM_ENUMS = ["item_class", "item_subtype", "case_shape", "material_kind", "acquisition_method", "extraction_status"] as const;

/**
 * Значения, которые программа читает по Коду: все значения закрытых перечней полей программы и
 * `hw_kind.storage` (Носитель, приложение §9). Их Код не меняется и они не поглощаются (DICT-60).
 */
export function programReadsByCode(enumCode: string, valueCode: string): boolean {
  return (PROGRAM_ENUMS as readonly string[]).includes(enumCode) || (enumCode === "hw_kind" && valueCode === "storage");
}

/**
 * Элементы, которые программа находит по Коду (T162): закрытые перечни полей программы, перечень
 * точности `geo_precision` (DICT-65), типы объектов `geo_object` (Район изъятия, DATA-16) и
 * `hw_element` (Носитель, DATA-13), тип Индикатора `hw_kind`. Их Код не меняется, и они не поглощаются.
 */
export function programReadsElement(kind: string, code: string): boolean {
  // Перечень hw_kind — тоже: иначе hw_kind.storage обходится переименованием перечня (T171).
  if (kind === "enum") return (PROGRAM_ENUMS as readonly string[]).includes(code) || code === "geo_precision" || code === "hw_kind";
  if (kind === "object_type") return code === "geo_object" || code === "hw_element";
  if (kind === "indicator_type") return code === "hw_kind";
  return false;
}

/**
 * Виды элементов Словаря (DICT-02). Классы изделий и подтип — значения закрытых перечней `item_class` и
 * `item_subtype` (DATA-05, DICT-60): у Класса один Идентификатор, а шаблон Формуляра ссылается на него.
 */
export const ELEMENT_KINDS = ["object_type", "link_type", "indicator_type", "enum", "enum_value"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/** Причины отказа применения версии (contracts/slovar-v1.md «Отказы»). */
export const SLOVAR_REJECT_REASONS = ["format", "signature", "stale", "gap", "chain", "conflict", "unsupported", "content"] as const;
export type SlovarRejectReason = (typeof SLOVAR_REJECT_REASONS)[number];

const Id = Type.String({ minLength: 1, maxLength: 64 });
const Code = Type.String({ pattern: "^[a-z][a-z0-9_]*$", maxLength: 64 });
/**
 * Код значения перечня. У перечней по внешним стандартам (timezone — имена tzdb, country — ISO 3166-1,
 * keyboard — раскладки XKB; приложение §7) Код — идентификатор стандарта, а не snake_case.
 */
// Скобки — у раскладок XKB с вариантом: de(nodeadkeys) (DICT-63; T268).
const ElementCode = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_/+.()-]*$", maxLength: 64 });
const SNAKE = /^[a-z][a-z0-9_]*$/;
/** Перечни, Коды значений которых — идентификаторы внешних стандартов. */
export const EXTERNAL_STANDARD_ENUMS = ["timezone", "country", "keyboard"] as const;
/**
 * Форма Кода по стандарту (DICT-63; T264): country — ISO 3166-1 alpha-2 или «00», timezone — имя tzdb
 * («Область/Место», «UTC»), keyboard — раскладка XKB («us», «de(nodeadkeys)»).
 */
const STANDARD_CODE: Record<(typeof EXTERNAL_STANDARD_ENUMS)[number], RegExp> = {
  country: /^([A-Z]{2}|00)$/,
  timezone: /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/,
  keyboard: /^[a-z][a-z0-9_]*(?:\([A-Za-z0-9_-]+\))?$/,
};

/** Код значения перечня по внешнему стандарту — по форме стандарта. */
export function isStandardCode(enumCode: string, code: string): boolean {
  return Object.hasOwn(STANDARD_CODE, enumCode) ? STANDARD_CODE[enumCode as keyof typeof STANDARD_CODE].test(code) : false;
}

/** Идентификатор элемента и списка — UUIDv7, время выпуска — UTC ISO 8601 (contracts/slovar-v1.md; T260). */
const Uuid7 = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" });
const IsoUtc = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$" });
const Label = Type.String({ minLength: 1, maxLength: 200 });
const Strict = { additionalProperties: false } as const;
/**
 * Текст с хотя бы одним печатным знаком и без NUL: не печатные — пробельные, управляющие C0 и C1,
 * невидимые нулевой ширины и форматирующие (DICT-41; T273).
 */
// Категории Юникода: Z — пробельные, C — управляющие, форматирующие (Cf) и прочие; знаки-заполнители
// хангыля и пустой знак Брайля печатаются пустыми (T281).
export const PRINTABLE_TEXT = "^[^\\x00]*[^\\s\\p{Z}\\p{C}\\p{Default_Ignorable_Code_Point}\\u115f\\u1160\\u3164\\uffa0\\u2800][^\\x00]*$";

/**
 * Особые знаки вместо Идентификатора элемента: виды Записей и ролей объектов (DICT-10; T172). Другой
 * знак с «@» — ссылка не на элемент версии, отказ.
 */
export const PSEUDO_REFS = ["@item", "@node", "@part", "@link", "@material", "@record"] as const;

/** Концы связи: Идентификаторы типов объектов или особые знаки из PSEUDO_REFS. */
const Ends = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });

export const PROPS_BY_KIND: Readonly<Record<ElementKind, TSchema>> = {
  object_type: Type.Object(
    {
      role: Type.Union([Type.Literal("node"), Type.Literal("part")]),
      /** Опознающие типы Индикаторов объекта (приложение §1). */
      identifying: Type.Optional(Type.Array(Id)),
    },
    Strict,
  ),
  link_type: Type.Object({ from: Ends, to: Ends, directed: Type.Boolean() }, Strict),
  indicator_type: Type.Object(
    {
      object: Id,
      format: Type.String({ minLength: 1 }),
      comparable: Type.Boolean(),
      normClass: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      identifying: Type.Union([Type.Literal("strict"), Type.Literal("loose"), Type.Literal("none")]),
      autoSecret: Type.Boolean(),
      /** Типы, с которыми значения сравниваются и между собой (IDENT-32). */
      crossCompare: Type.Optional(Type.Array(Id)),
      /** Прежние имена картотеки (приложение §6) — для импорта, фича 017. */
      legacyNames: Type.Optional(Type.Array(Type.String())),
    },
    Strict,
  ),
  enum: Type.Object(
    {
      closed: Type.Boolean(),
      /** Прежнее имя → действующее значение (timezone: Europe/Kiev → Europe/Kyiv; приложение §7). */
      aliases: Type.Optional(Type.Record(Type.String(), Type.String())),
    },
    Strict,
  ),
  enum_value: Type.Object({ enum: Id, draft: Type.Optional(Type.Boolean()) }, Strict),
};

export const SlovarElement = Type.Object(
  {
    id: Uuid7,
    code: ElementCode,
    label: Label,
    kind: Type.Union([Type.Literal("object_type"), Type.Literal("link_type"), Type.Literal("indicator_type"), Type.Literal("enum"), Type.Literal("enum_value")]),
    state: Type.Union([Type.Literal("active"), Type.Literal("deprecated"), Type.Literal("absorbed")]),
    canonical: Type.Optional(Id),
    sinceVersion: Type.Integer({ minimum: 1 }),
    props: Type.Record(Type.String(), Type.Unknown()),
  },
  Strict,
);
export type SlovarElement = Static<typeof SlovarElement>;

export const TemplateField = Type.Object(
  {
    label: Label,
    required: Type.Boolean(),
    defaultSource: Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
    format: Type.Optional(Type.String()),
    /** Куда ложится значение (приложение §9): поле программы, объект, типы Индикаторов, связь. */
    target: Type.Object(
      {
        programField: Type.Optional(Type.String()),
        objectKind: Type.Optional(Id),
        indicatorTypes: Type.Optional(Type.Array(Id)),
        link: Type.Optional(Id),
        material: Type.Optional(Type.Boolean()),
      },
      Strict,
    ),
    note: Type.Optional(Type.String()),
  },
  Strict,
);
export type TemplateField = Static<typeof TemplateField>;

export const TEMPLATE_BLOCKS = ["header", "media", "os", "class"] as const;
export type TemplateBlock = (typeof TEMPLATE_BLOCKS)[number];

export const SlovarTemplate = Type.Object(
  {
    class: Id,
    subtype: Type.Optional(Id),
    blocks: Type.Array(
      Type.Object({ block: Type.Union([Type.Literal("header"), Type.Literal("media"), Type.Literal("os"), Type.Literal("class")]), fields: Type.Array(TemplateField) }, Strict),
    ),
  },
  Strict,
);
export type SlovarTemplate = Static<typeof SlovarTemplate>;

const StopListKind = Type.Union([Type.Literal("value"), Type.Literal("range"), Type.Literal("pattern")]);
/**
 * Пояснение строки Стоп-листа: хотя бы один печатный символ и ни одного NUL — как ограничение БД
 * «непустой текст» (SQLite length() обрывается на NUL); иначе версия не применилась бы (T188).
 */
const Note = Type.String({ minLength: 1, pattern: PRINTABLE_TEXT });

export const SlovarStopList = Type.Object(
  {
    id: Uuid7,
    code: Code,
    label: Label,
    source: Type.String({ minLength: 1 }),
    builtAt: Type.String({ minLength: 1 }),
    rows: Type.Array(Type.Tuple([Id, StopListKind, Type.String({ minLength: 1 }), Note])),
  },
  Strict,
);
export type SlovarStopList = Static<typeof SlovarStopList>;

export const SlovarMerge = Type.Union([
  Type.Object({ absorbed: Id, canonical: Id }, Strict),
  Type.Object({ local: Type.String({ pattern: "^[A-Z][A-Z0-9]{0,7}:[a-z][a-z0-9_]*$" }), localId: Id, canonical: Id }, Strict),
]);
export type SlovarMerge = Static<typeof SlovarMerge>;

export const SlovarBody = Type.Object(
  {
    number: Type.Integer({ minimum: 1 }),
    issuedAt: IsoUtc,
    previousSha256: Type.Union([Type.String({ pattern: "^[0-9a-f]{64}$" }), Type.Null()]),
    programRequirements: Type.Object({ normClasses: Type.Array(Type.String()), materialKinds: Type.Array(Type.String()) }, Strict),
    elements: Type.Array(SlovarElement),
    templates: Type.Array(SlovarTemplate),
    stopLists: Type.Array(SlovarStopList),
    merges: Type.Array(SlovarMerge),
  },
  Strict,
);
export type SlovarBody = Static<typeof SlovarBody>;

/** Тело или файл не по схеме — отказ `format`. */
export class SlovarFormatError extends Error {
  readonly reason = "format";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SlovarFormatError(message("slovar_not_json"));
  }
}

/** Все строки и имена полей — правильно построенный Юникод: одиночный суррогат искажает нормализованную форму (DICT-40, DICT-41; T201). */
function wellFormed(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(wellFormed);
  if (typeof value === "object" && value !== null) return Object.entries(value).every(([k, v]) => k.isWellFormed() && wellFormed(v));
  return true;
}

/** Где и что не по схеме — по-русски, английский текст TypeBox людям не показывается (конституция VIII; T241). */
function where(schema: TSchema, value: unknown): string {
  return describeIssues([...Value.Errors(schema, value)] as unknown as SchemaIssue[], "body");
}

export function parseSlovarBody(text: string): SlovarBody {
  const value = parseJson(text);
  if (!Value.Check(SlovarBody, value)) throw new SlovarFormatError(message("slovar_body_invalid", { where: where(SlovarBody, value) }));
  if (!wellFormed(value)) throw new SlovarFormatError(message("slovar_not_well_formed"));
  const body = value as SlovarBody;
  if ((body.number === 1) !== (body.previousSha256 === null)) throw new SlovarFormatError(message("slovar_body_invalid", { where: "/previousSha256" }));
  // Время выпуска — существующее время UTC, а не только по форме (T274).
  if (isoInstant(body.issuedAt) === undefined) throw new SlovarFormatError(message("slovar_body_invalid", { where: "/issuedAt" }));
  const externalEnums = new Map(
    body.elements.filter((el) => el.kind === "enum" && (EXTERNAL_STANDARD_ENUMS as readonly string[]).includes(el.code)).map((el) => [el.id, el.code]),
  );
  for (const el of body.elements) {
    const external = el.kind === "enum_value" ? externalEnums.get(String(el.props["enum"])) : undefined;
    if (external === undefined ? !SNAKE.test(el.code) : !isStandardCode(external, el.code)) throw new SlovarFormatError(message("slovar_body_invalid", { where: `${el.code} code` }));
    const schema = PROPS_BY_KIND[el.kind];
    if (!Value.Check(schema, el.props)) throw new SlovarFormatError(message("slovar_body_invalid", { where: `${el.code} ${where(schema, el.props)}` }));
    if ((el.state === "absorbed") !== (el.canonical !== undefined)) throw new SlovarFormatError(message("slovar_body_invalid", { where: `${el.code} canonical` }));
  }
  return body;
}

export const StopListFile = Type.Object(
  {
    format: Type.Literal(STOP_LIST_FILE_FORMAT),
    code: Code,
    label: Label,
    source: Type.String({ minLength: 1 }),
    builtAt: Type.String({ minLength: 1 }),
    rows: Type.Array(Type.Object({ type: Code, kind: StopListKind, value: Type.String({ minLength: 1 }), note: Note }, Strict)),
  },
  Strict,
);
export type StopListFile = Static<typeof StopListFile>;

/** Файл исходника Словаря Сети по схеме: не JSON или не по схеме — SlovarFormatError (T214). */
export function parseSourceFile<T extends TSchema>(text: string, schema: T): Static<T> {
  const value = parseJson(text);
  if (!Value.Check(schema, value)) throw new SlovarFormatError(message("slovar_source_invalid", { where: where(schema, value) }));
  if (!wellFormed(value)) throw new SlovarFormatError(message("slovar_not_well_formed"));
  return value as Static<T>;
}

export function parseStopListFile(text: string): StopListFile {
  const value = parseJson(text);
  if (!Value.Check(StopListFile, value)) throw new SlovarFormatError(message("stop_list_file_invalid", { where: where(StopListFile, value) }));
  if (!wellFormed(value)) throw new SlovarFormatError(message("slovar_not_well_formed"));
  return value as StopListFile;
}
