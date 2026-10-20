// Схемы маршрутов Словаря Сети JSON API (contracts/http-api.md фичи 005, «Словарь Сети»).
import { Type, type Static } from "typebox";

export const DictionaryCurrent = Type.Object({
  number: Type.Integer(),
  bodySha256: Type.String(),
  appliedAt: Type.String(),
  appliedBy: Type.Object({ id: Type.Union([Type.String(), Type.Null()]), label: Type.String() }),
  signedBy: Type.Object({ key: Type.String(), keyFingerprint: Type.String() }),
  /** Счётчики применения — только в ответе 201 подачи версии (contracts/http-api.md). */
  applied: Type.Optional(Type.Record(Type.String(), Type.Integer())),
});
export type DictionaryCurrent = Static<typeof DictionaryCurrent>;

/** GET /api/dictionary: применённая версия; до версии 1 — current: null. */
export const DictionaryStateResponse = Type.Object({ current: Type.Union([DictionaryCurrent, Type.Null()]) });
export type DictionaryState = Static<typeof DictionaryStateResponse>;

export const DictionaryNumberParams = Type.Object({ number: Type.Integer({ minimum: 1 }) });

export const DictElementView = Type.Object({
  id: Type.String(),
  code: Type.String(),
  label: Type.String(),
  kind: Type.String(),
  level: Type.String(),
  state: Type.String(),
  canonicalId: Type.Union([Type.String(), Type.Null()]),
  sinceVersion: Type.Union([Type.Integer(), Type.Null()]),
  /** Эффективные свойства: Сеть и ужесточения Местного расширения (DICT-07). */
  props: Type.Record(Type.String(), Type.Unknown()),
});
export type DictElementView = Static<typeof DictElementView>;

export const DictElementsQuery = Type.Object(
  {
    kind: Type.Optional(Type.String()),
    code: Type.Optional(Type.String()),
    level: Type.Optional(Type.Union([Type.Literal("network"), Type.Literal("local")])),
  },
  { additionalProperties: false },
);
export const DictElementsResponse = Type.Object({ items: Type.Array(DictElementView) });

export const StopListView = Type.Object({
  id: Type.String(),
  code: Type.String(),
  label: Type.String(),
  source: Type.String(),
  builtAt: Type.String(),
  rows: Type.Integer(),
  level: Type.String(),
});
export const StopListsResponse = Type.Object({ items: Type.Array(StopListView) });

export const StopListEntryView = Type.Object({
  id: Type.String(),
  typeId: Type.String(),
  kind: Type.String(),
  value: Type.String(),
  normalized: Type.String(),
  note: Type.String(),
});
export const StopListCodeParams = Type.Object({ code: Type.String({ minLength: 1 }) });
export const PageQuery = Type.Object(
  { cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) },
  { additionalProperties: false },
);
export const StopListEntriesResponse = Type.Object({ items: Type.Array(StopListEntryView), cursor: Type.Union([Type.String(), Type.Null()]) });

export const StopListIndicatorsQuery = Type.Object(
  { stopList: Type.String({ minLength: 1 }), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) },
  { additionalProperties: false },
);

/** Ответ GET /api/form (contracts/http-api.md фичи 005). */
export interface FormDescriptionView {
  class: string;
  subtype: string | null;
  general: { field: string; label: string; required: boolean; defaultSource: string; code: string }[];
  blocks: { block: string; fields: { label: string; required: boolean; defaultSource: string; target: Record<string, unknown>; local: boolean; deprecated: boolean; format: string | null; formats: Record<string, string | null> }[] }[];
}
