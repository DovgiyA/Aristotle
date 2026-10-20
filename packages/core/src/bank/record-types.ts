// Реестр типов Записей (FR-004). В поставке фичи 001 он пуст: типы предметной модели
// появятся в фиче 005, а механизм проверяется на служебном типе test.note только в тестах.
import type { TSchema } from "typebox";
import { message, type BankRecord } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import type { AppliedDictionary } from "../dictionary/current.ts";
import type { Reader } from "./visibility.ts";

/** Окружение ловушек типа: всё внутри транзакции изменения (research R2 фичи 005). */
export interface RecordContext {
  db: Db;
  authorId: string;
  at: string;
  /** Применённый Словарь Сети; до версии 1 — undefined. */
  dictionary: AppliedDictionary | undefined;
  /**
   * Правка из маршрута предмета, а не общего PATCH /api/records/:id: какие поля он вправе менять
   * (research R3 фичи 006 — у Записи о Материале меняется только вид). undefined — общий маршрут.
   */
  allowFields?: readonly string[];
  /**
   * Вид действия журнала маршрута предмета (WriteOptions.action) — у Записи о Материале создание
   * разрешено только регистрацией material.register (research R3 фичи 006). undefined — общий маршрут.
   */
  purpose?: string;
}

export interface Prepared {
  fields: Record<string, unknown>;
  /** Поставить метку Секрет при создании (ROLE-25). */
  secret?: boolean;
}

export interface RecordType {
  /** Имя типа, например test.note. */
  name: string;
  /** Схема поля fields. */
  fields: TSchema;
  /** Текст Записи для поискового индекса. */
  indexText: (fields: Record<string, unknown>) => string;
  /**
   * Проверка по Словарю и полям программы, значения по умолчанию; previous — Запись до правки.
   * Отказ — ApiError model_invalid: тогда нет ни Записи, ни истории, ни журнала.
   */
  prepare?: (ctx: RecordContext, fields: Record<string, unknown>, previous?: BankRecord) => Prepared;
  /** Производное в той же транзакции: нормализованная форма, принадлежность Кейсу. */
  derive?: (ctx: RecordContext, record: BankRecord) => void;
  /** Кейс, к которому относится Запись, — колонка журнала caseId (INBOX-32, DATA-36). */
  caseOf?: (ctx: RecordContext, record: BankRecord) => string | null;
  /**
   * Что из полей уходит в пакеты по Соглашениям (фича 020): false — поле не уходит (DATA-21 —
   * исполнители Кейса). Нет записи — уходит.
   */
  exchange?: Record<string, boolean>;
  /**
   * Метку Секрет нельзя снять никому — крипто-задача (BANK-62, ROLE-18; фича 006). Снятие — отказ
   * secret_crypto_task.
   */
  secretLocked?: (record: BankRecord, db: Db) => boolean;
  /** Вид для ответа API: подпись, метки, нормализованная форма (не хранится). */
  view?: (ctx: RecordContext, record: BankRecord, reader: Reader | undefined) => Record<string, unknown>;
}

const registry = new Map<string, RecordType>();

export function registerRecordType(type: RecordType): void {
  // «$secret» в истории — метка Секрет, а не поле: имена полей с «$» запрещены (research R2).
  const properties = (type.fields as { properties?: Record<string, unknown> }).properties ?? {};
  const reserved = Object.keys(properties).find((name) => name.startsWith("$"));
  if (reserved !== undefined) throw new Error(message("record_type_reserved_field", { type: type.name, field: reserved }));
  registry.set(type.name, type);
}

export function getRecordType(name: string): RecordType | undefined {
  return registry.get(name);
}

export function unregisterRecordType(name: string): void {
  registry.delete(name);
}
