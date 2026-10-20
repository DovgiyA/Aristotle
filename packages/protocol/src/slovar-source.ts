// Исходник версии Словаря Сети (research R5 фичи 005): элементы названы Кодами, Идентификаторы выдаёт
// сборка версии. Каталог dictionary/source/: types.json, enums.json, classes.json, merges.json,
// stop-lists.json (ожидаемые списки §8), stop-lists/<код>.json (aristotel/stop-list/v1). Схемы файлов
// проверяются при чтении исходника: испорченный файл — причина с его именем, а не сбой сборки (T214).
import { Type, type Static } from "typebox";

const Str = Type.String();
/** Строгие объекты: лишнее или опечатанное поле — отказ, а не тихая потеря (T249). */
const Strict = { additionalProperties: false } as const;
const Strs = Type.Array(Type.String());

export const SourceObjectType = Type.Object({ code: Str, label: Str, role: Type.Union([Type.Literal("node"), Type.Literal("part")]), identifying: Strs }, Strict);
export type SourceObjectType = Static<typeof SourceObjectType>;
export const SourceLinkType = Type.Object({ code: Str, label: Str, from: Strs, to: Strs, directed: Type.Boolean() }, Strict);
export type SourceLinkType = Static<typeof SourceLinkType>;
export const SourceIndicatorType = Type.Object({
  code: Str,
  label: Str,
  object: Str,
  format: Str,
  comparable: Type.Boolean(),
  normClass: Type.Union([Str, Type.Null()]),
  identifying: Type.Union([Type.Literal("strict"), Type.Literal("loose"), Type.Literal("none")]),
  autoSecret: Type.Boolean(),
  crossCompare: Type.Optional(Strs),
  legacyNames: Strs,
}, Strict);
export type SourceIndicatorType = Static<typeof SourceIndicatorType>;
export const SourceEnum = Type.Object({
  code: Str,
  closed: Type.Boolean(),
  values: Type.Array(Type.Object({ code: Str, label: Str, draft: Type.Optional(Type.Boolean()) }, Strict)),
  aliases: Type.Optional(Type.Record(Type.String(), Type.String())),
}, Strict);
export type SourceEnum = Static<typeof SourceEnum>;
export const SourceField = Type.Object({
  label: Str,
  required: Type.Boolean(),
  defaultSource: Type.Union([Type.Literal("auto"), Type.Literal("manual")]),
  target: Type.Object({
    programField: Type.Optional(Str),
    objectKind: Type.Optional(Str),
    indicatorTypes: Type.Optional(Strs),
    link: Type.Optional(Str),
    material: Type.Optional(Type.Boolean()),
  }, Strict),
  /** Формат поля — у поля шаблона, иначе формат типа (DATA-23; T248). */
  format: Type.Optional(Str),
  note: Type.Optional(Str),
}, Strict);
export type SourceField = Static<typeof SourceField>;
export const SourceTemplate = Type.Object({
  class: Str,
  subtype: Type.Optional(Str),
  blocks: Type.Array(Type.Object({ block: Type.Union([Type.Literal("header"), Type.Literal("media"), Type.Literal("os"), Type.Literal("class")]), fields: Type.Array(SourceField) }, Strict)),
}, Strict);
export type SourceTemplate = Static<typeof SourceTemplate>;
export const ExpectedStopList = Type.Object({
  code: Str,
  label: Str,
  section: Str,
  source: Str,
  /** Число строк по приложению §8. */
  rows: Type.Integer(),
}, Strict);
export type ExpectedStopList = Static<typeof ExpectedStopList>;

export interface SourceStopList {
  format: "aristotel/stop-list/v1";
  code: string;
  label: string;
  source: string;
  builtAt: string;
  rows: { type: string; kind: "value" | "range" | "pattern"; value: string; note: string }[];
}

/** Файлы каталога исходника (кроме списков Стоп-листа — у них свой формат). */
export const SourceTypesFile = Type.Object({ objectTypes: Type.Array(SourceObjectType), linkTypes: Type.Array(SourceLinkType), indicatorTypes: Type.Array(SourceIndicatorType) }, Strict);
export const SourceEnumsFile = Type.Array(SourceEnum);
export const SourceClassesFile = Type.Object({ templates: Type.Array(SourceTemplate) }, Strict);
/**
 * Склейки и устаревшие элементы этой версии (DICT-12, DICT-13, DICT-22): Коды вида «вид:код». Состояния
 * прежних версий сборка переносит сама. renamed — смена Кода с тем же Идентификатором (DICT-10).
 */
export const SourceMergesFile = Type.Object({
  synonyms: Type.Array(Type.Object({ absorbed: Str, canonical: Str }, Strict)),
  localTypes: Type.Array(Type.Object({ local: Str, localId: Str, canonical: Str }, Strict)),
  deprecated: Strs,
  renamed: Type.Optional(Type.Array(Type.Object({ from: Str, to: Str }, Strict))),
}, Strict);
export const SourceExpectedStopListsFile = Type.Array(ExpectedStopList);

export interface DictionarySource {
  types: Static<typeof SourceTypesFile>;
  enums: SourceEnum[];
  classes: Static<typeof SourceClassesFile>;
  merges: Static<typeof SourceMergesFile>;
  stopLists: SourceStopList[];
  /** Все списки Стоп-листа версии по приложению §8: каких нет в каталоге, те подаются файлами. */
  expectedStopLists: ExpectedStopList[];
}
