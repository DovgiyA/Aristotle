// Схемы Записи, изменения, истории и метки Секрет (data-model.md «record», «record_history» фич 001 и
// 002; contracts/http-api.md; ROLE-24).
import { Type, type Static } from "typebox";

export const RecordFields = Type.Record(Type.String(), Type.Unknown());

export const BankRecord = Type.Object({
  id: Type.String(),
  type: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  fields: RecordFields,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  createdBy: Type.String(),
  updatedBy: Type.String(),
  /** Метка Секрет (ROLE-24). */
  secret: Type.Boolean(),
  /** Вид Записи модели данных для ответа: подпись, метки, нормализованная форма — не хранится (фича 005). */
  view: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type BankRecord = Static<typeof BankRecord>;

export const CreateRecordRequest = Type.Object(
  { type: Type.String({ minLength: 1 }), fields: RecordFields, secret: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

export type CreateRecordRequest = Static<typeof CreateRecordRequest>;

export const UpdateRecordRequest = Type.Object(
  { expectedVersion: Type.Integer({ minimum: 1 }), fields: RecordFields },
  { additionalProperties: false },
);

export type UpdateRecordRequest = Static<typeof UpdateRecordRequest>;

/** Поставить или снять метку Секрет: только версия, действие задаёт маршрут (research R1, R2). */
export const SecretMarkRequest = Type.Object(
  { expectedVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export type SecretMarkRequest = Static<typeof SecretMarkRequest>;

/** Имя строки истории метки Секрет; имена полей типов Записей с «$» не начинаются (research R2). */
export const SECRET_HISTORY_FIELD = "$secret";
/** Строка истории удаления Материала Старшим: { at, by, reason } (BANK-12; research R10 фичи 006). */
export const DELETED_HISTORY_FIELD = "$deleted";

export const HistoryItem = Type.Object({
  /** Сквозной номер строки истории; Наблюдателю — null (VIEW-59). */
  seq: Type.Union([Type.Integer(), Type.Null()]),
  version: Type.Integer(),
  field: Type.String(),
  before: Type.Unknown(),
  after: Type.Unknown(),
  authorId: Type.String(),
  at: Type.String(),
});

export type HistoryItem = Static<typeof HistoryItem>;

export const HistoryResponse = Type.Object({ items: Type.Array(HistoryItem) });

export const RecordIdParams = Type.Object({ id: Type.String() });
