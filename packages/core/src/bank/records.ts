// Записи Банка: создание, чтение, изменение и метка Секрет одной транзакцией вместе с историей,
// журналом и поисковым индексом (BANK-04, BANK-05, BANK-07, BANK-20, BANK-22, INBOX-30; research R5,
// R6 фичи 001). Чтение учитывает читающего: Наблюдатель Секрет-Записей не видит (ROLE-17, ROLE-18,
// ROLE-24, VIEW-16, VIEW-58; research R2, R3 фичи 002).
import { randomUUIDv7 } from "node:crypto";
import { Value } from "typebox/value";
import { SECRET_HISTORY_FIELD, describeIssues, message, type Action, type BankRecord, type HistoryItem, type SchemaIssue } from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { getRecordType, type RecordContext, type RecordType } from "./record-types.ts";
import { currentDictionary } from "../dictionary/current.ts";
import { modelInvalid } from "../model/validate.ts";
import { canSeeRecord, seesSequenceNumbers, type Reader } from "./visibility.ts";
import { assertActor } from "../rights/rights.ts";

type Fields = Record<string, unknown>;

/** Точки внедрения сбоя — только для тестов транзакции (T037). */
export interface Faults {
  afterHistory?: () => void;
}

/**
 * Запись из маршрута предмета (фича 006): свой Идентификатор, свой вид действия журнала и право, работа
 * в той же транзакции до журнала. Без опций — общие маршруты /api/records.
 */
export interface WriteOptions {
  /** Идентификатор новой Записи — у Материала его выдаёт Станция без согласования (BANK-21). */
  id?: string;
  /** Вид действия журнала вместо record.create / record.update. */
  action?: string;
  /** details записи журнала. */
  details?: Record<string, unknown>;
  /** Право автора вместо record.create / record.update. */
  right?: Action;
  /** Поля, которые правка вправе менять (RecordContext.allowFields). */
  allowFields?: readonly string[];
  /** Внутри транзакции после строки Записи и истории, до журнала: производные таблицы предмета. */
  within?: (record: BankRecord, at: string) => void;
  faults?: Faults;
}

function recordType(name: string): RecordType {
  const type = getRecordType(name);
  if (type === undefined) throw new ApiError("invalid_request", { detail: message("detail_unknown_record_type", { type: name }) });
  return type;
}

function checkFields(type: RecordType, fields: Fields): void {
  // Имена с «$» заняты метками программы («$secret» в истории), и тип с открытыми полями их не
  // пропускает — проверяются сохраняемые поля, а не только схема типа (research R2).
  const reserved = Object.keys(fields).find((name) => name.startsWith("$"));
  if (reserved !== undefined) throw new ApiError("invalid_request", { detail: message("detail_reserved_field", { field: reserved }) });
  if (!Value.Check(type.fields, fields)) {
    const issues = [...Value.Errors(type.fields, fields)] as unknown as SchemaIssue[];
    // Записи модели (с ловушкой prepare) — 400 model_invalid с details.issues по полям (T041, DATA-20).
    if (type.prepare !== undefined) {
      // Имя поля — из пути; у «нет обязательного» и «лишнее поле» на верхнем уровне путь пуст — из параметров.
      const names = new Set<string>();
      for (const i of issues as unknown as { instancePath?: string; params?: { requiredProperties?: string[]; additionalProperties?: string[] } }[]) {
        const top = String(i.instancePath ?? "").split("/")[1] ?? "";
        if (top !== "") names.add(top);
        else for (const n of [...(i.params?.requiredProperties ?? []), ...(i.params?.additionalProperties ?? [])]) names.add(n);
      }
      throw modelInvalid([...names].map((field) => ({ field, rule: "field" as const, code: "field" })));
    }
    const where = ` (${describeIssues(issues, "fields")})`;
    throw new ApiError("invalid_request", { detail: message("detail_fields_mismatch", { type: type.name, where }) });
  }
  // Строки Записей модели — правильно построенный Юникод: одиночный суррогат искажает нормализованную
  // форму и индекс поиска (DICT-37; T202).
  if (type.prepare !== undefined) {
    const bad = Object.entries(fields).filter(([name, value]) => !name.isWellFormed() || !wellFormed(value)).map(([name]) => name);
    if (bad.length > 0) throw modelInvalid(bad.map((field) => ({ field, rule: "format" as const, code: "not_well_formed" })));
  }
}

function wellFormed(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(wellFormed);
  if (typeof value === "object" && value !== null) return Object.entries(value).every(([k, v]) => k.isWellFormed() && wellFormed(v));
  return true;
}

function rowToRecord(row: Record<string, unknown>): BankRecord {
  return {
    id: String(row["id"]),
    type: String(row["type"]),
    version: Number(row["version"]),
    fields: JSON.parse(String(row["fields"])) as Fields,
    createdAt: String(row["createdAt"]),
    updatedAt: String(row["updatedAt"]),
    createdBy: String(row["createdBy"]),
    updatedBy: String(row["updatedBy"]),
    secret: Number(row["secret"]) === 1,
  };
}

/**
 * Структурное равенство значений JSON: порядок ключей объекта не важен, порядок элементов
 * массива важен (ревью, P2; «было» равно «стало» — не изменение).
 */
/** Равенство по структуре: порядок ключей объекта не важен (общее для правки Записей и модели, T164). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** Записать строки истории по изменённым полям; вернуть диапазон seq или null. */
function writeHistory(
  db: Db,
  recordId: string,
  version: number,
  before: Fields,
  after: Fields,
  authorId: string,
  at: string,
): { from: number; to: number } | null {
  const insert = db.prepare(
    "INSERT INTO record_history (recordId, version, field, before, after, authorId, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let from: number | null = null;
  let to: number | null = null;
  // Снятое поле (было — нет) — строка с after = null: версия восстанавливается по истории (BANK-07; T257).
  for (const field of Object.keys(before)) {
    if (field in after || before[field] === null) continue;
    const result = insert.run(recordId, version, field, JSON.stringify(before[field]), "null", authorId, at);
    const seq = Number(result.lastInsertRowid);
    from ??= seq;
    to = seq;
  }
  for (const field of Object.keys(after)) {
    if (sameValue(before[field] ?? null, after[field] ?? null)) continue;
    const result = insert.run(
      recordId,
      version,
      field,
      field in before ? JSON.stringify(before[field]) : null,
      JSON.stringify(after[field]),
      authorId,
      at,
    );
    const seq = Number(result.lastInsertRowid);
    from ??= seq;
    to = seq;
  }
  return from === null || to === null ? null : { from, to };
}

/** Строка истории метки Секрет: «было» — прежнее значение или null при создании (research R2). */
function writeSecretHistory(db: Db, recordId: string, version: number, before: boolean | null, after: boolean, authorId: string, at: string): number {
  const result = db
    .prepare("INSERT INTO record_history (recordId, version, field, before, after, authorId, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(recordId, version, SECRET_HISTORY_FIELD, before === null ? null : JSON.stringify(before), JSON.stringify(after), authorId, at);
  return Number(result.lastInsertRowid);
}

function writeJournal(
  db: Db,
  action: string,
  recordId: string,
  authorId: string | null,
  at: string,
  range: { from: number; to: number } | null,
  details: Record<string, unknown> | null = null,
  caseId: string | null = null,
): void {
  db.prepare(
    "INSERT INTO journal (at, actorId, action, subjectType, subjectId, historyFrom, historyTo, details, caseId) VALUES (?, ?, ?, 'record', ?, ?, ?, ?, ?)",
  ).run(at, authorId, action, recordId, range?.from ?? null, range?.to ?? null, details === null ? null : JSON.stringify(details), caseId);
}

/** Окружение ловушек типа (research R2 фичи 005). */
export function recordContext(db: Db, authorId: string, at: string): RecordContext {
  return { db, authorId, at, dictionary: currentDictionary(db) };
}

function readRow(db: Db, id: string): BankRecord {
  return rowToRecord(db.prepare("SELECT * FROM record WHERE id = ?").get(id) ?? {});
}

/** Производное и Кейс Записи после записи строки — в той же транзакции (research R2, R12 фичи 005). */
function afterWrite(type: RecordType, ctx: RecordContext, record: BankRecord): string | null {
  type.derive?.(ctx, record);
  return type.caseOf?.(ctx, record) ?? null;
}

/** Ответ API с видом Записи (подпись, метки) — у типов модели; не хранится. */
export function withView(db: Db, record: BankRecord, reader?: Reader): BankRecord {
  const type = getRecordType(record.type);
  if (type?.view === undefined) return record;
  return { ...record, view: type.view(recordContext(db, record.updatedBy, record.updatedAt), record, reader) };
}

function writeIndex(db: Db, type: RecordType, recordId: string, fields: Fields): void {
  db.prepare("DELETE FROM record_fts WHERE recordId = ?").run(recordId);
  db.prepare("INSERT INTO record_fts (recordId, text) VALUES (?, ?)").run(recordId, type.indexText(fields));
}

/**
 * Запись, если читающий её видит; для Наблюдателя Секрет-Записи нет, как несуществующей (VIEW-16).
 * Без читающего — внутреннее чтение ядра.
 */
export function getRecord(db: Db, id: string, reader?: Reader): BankRecord | undefined {
  const row = db.prepare("SELECT * FROM record WHERE id = ?").get(id);
  if (row === undefined) return undefined;
  const record = rowToRecord(row);
  return canSeeRecord(reader, record.secret) ? record : undefined;
}

export function createRecord(db: Db, request: { type: string; fields: Fields; secret?: boolean }, authorId: string, options: WriteOptions = {}): BankRecord {
  const type = recordType(request.type);
  if (type.prepare === undefined) checkFields(type, request.fields);
  // Зарезервированные имена — до снятия null: «$secret: null» тоже отказ (T289).
  const reserved = Object.keys(request.fields).find((name) => name.startsWith("$"));
  if (reserved !== undefined) throw new ApiError("invalid_request", { detail: message("detail_reserved_field", { field: reserved }) });
  return inTransaction(db, () => {
    assertActor(db, authorId, options.right ?? "record.create");
    const id = options.id ?? randomUUIDv7();
    const at = new Date().toISOString();
    const ctx: RecordContext = options.action === undefined ? recordContext(db, authorId, at) : { ...recordContext(db, authorId, at), purpose: options.action };
    // Ловушка типа дополняет поля (Номер Кейса, значения по умолчанию) и проверяет их по Словарю.
    // null у поля, которого нет, — как его отсутствие, и при создании (T276; T287).
    const input: Fields = { ...request.fields };
    if (type.prepare !== undefined) for (const f of Object.keys(input)) if (input[f] === null) delete input[f];
    const prepared = type.prepare === undefined ? { fields: input } : type.prepare(ctx, input);
    const fields = prepared.fields;
    if (type.prepare !== undefined) checkFields(type, fields);
    const secret = request.secret === true || prepared.secret === true;
    db.prepare(
      "INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)",
    ).run(id, type.name, JSON.stringify(fields), at, at, authorId, authorId, secret ? 1 : 0);
    let range = writeHistory(db, id, 1, {}, fields, authorId, at);
    if (secret) {
      // Запись создана сразу Секретом: у Наблюдателя её не бывает и мгновения (research R2).
      const seq = writeSecretHistory(db, id, 1, null, true, authorId, at);
      range = { from: range?.from ?? seq, to: seq };
    }
    const caseId = afterWrite(type, ctx, readRow(db, id));
    options.within?.(readRow(db, id), at);
    const details = options.details === undefined && !secret ? null : { ...(options.details ?? {}), ...(secret ? { secret: true } : {}) };
    writeJournal(db, options.action ?? "record.create", id, authorId, at, range, details, caseId);
    writeIndex(db, type, id, fields);
    return readRow(db, id);
  });
}

/**
 * Изменить поля Записи. Переданные поля заменяют прежние значения, остальные остаются.
 * Изменение без разницы не создаёт ни истории, ни журнала и версию не меняет.
 */
export function updateRecord(
  db: Db,
  id: string,
  request: { expectedVersion: number; fields: Fields },
  authorId: string,
  faults: Faults = {},
): BankRecord {
  return inTransaction(db, () => updateRecordInTx(db, id, request, authorId, { faults }));
}

/**
 * Правка внутри транзакции вызывающего — общая для PATCH /api/records/:id и маршрутов предметов
 * (research R3 фичи 006): allowFields передаётся ловушке prepare, вид журнала и право — из опций.
 */
export function updateRecordInTx(
  db: Db,
  id: string,
  request: { expectedVersion: number; fields: Fields },
  authorId: string,
  options: WriteOptions = {},
): BankRecord {
  const faults = options.faults ?? {};
  assertActor(db, authorId, options.right ?? "record.update");
  const current = getRecord(db, id);
  if (current === undefined) throw new ApiError("not_found", { id });
  // Оптимистическая блокировка: сохранение поверх другой версии отклоняется, правящий получает
  // текущую Запись и изменения после своей версии (BANK-09; research R9).
  if (current.version !== request.expectedVersion) throw versionConflict(db, current, request.expectedVersion);
  const type = recordType(current.type);
  const reserved = Object.keys(request.fields).find((name) => name.startsWith("$"));
  if (reserved !== undefined) throw new ApiError("invalid_request", { detail: message("detail_reserved_field", { field: reserved }) });
  const at = new Date().toISOString();
  const ctx: RecordContext = options.allowFields === undefined ? recordContext(db, authorId, at) : { ...recordContext(db, authorId, at), allowFields: options.allowFields };
  // null у поля, которого нет, — не правка: снимается до проверок модели, иначе {state: null} стёр бы
  // значение, а {correction: null} получил бы отказ (BANK-07; T267, T276).
  // У Записи модели null у имеющегося поля — его снятие, как отсутствие (T288).
  const requested: Fields = { ...request.fields };
  const removed: string[] = [];
  for (const f of Object.keys(requested)) {
    if (requested[f] !== null || (type.prepare === undefined && f in current.fields)) continue;
    delete requested[f];
    if (f in current.fields) removed.push(f);
  }
  const merged: Fields = { ...current.fields, ...requested };
  for (const f of removed) delete merged[f];
  const next: Fields = type.prepare === undefined ? merged : type.prepare(ctx, merged, current).fields;
  // Поля нет и поле null — одно и то же: null у отсутствующего поля не изменение (BANK-07; T267).
  for (const f of Object.keys(next)) if (next[f] === null && !(f in current.fields)) delete next[f];
  checkFields(type, next);
  const keys = new Set([...Object.keys(next), ...Object.keys(current.fields)]);
  const changed = [...keys].some((f) => !sameValue(current.fields[f] ?? null, next[f] ?? null));
  if (!changed) return current;
  const version = current.version + 1;
  const updated = db
    .prepare("UPDATE record SET fields = ?, version = ?, updatedAt = ?, updatedBy = ? WHERE id = ? AND version = ?")
    .run(JSON.stringify(next), version, at, authorId, id, current.version);
  if (Number(updated.changes) === 0) throw versionConflict(db, getRecord(db, id) ?? current, request.expectedVersion);
  const range = writeHistory(db, id, version, current.fields, next, authorId, at);
  faults.afterHistory?.();
  const caseId = afterWrite(type, ctx, readRow(db, id));
  options.within?.(readRow(db, id), at);
  writeJournal(db, options.action ?? "record.update", id, authorId, at, range, options.details ?? null, caseId);
  writeIndex(db, type, id, next);
  return readRow(db, id);
}

/**
 * Служебная строка истории (поле с «$», как «$secret»): версия +1, updatedAt, updatedBy, журнал — в
 * транзакции вызывающего. Удаление Материала Старшим — «$deleted» (research R10 фичи 006). Запись уже
 * изменили — version_conflict.
 */
export function writeServiceChangeInTx(
  db: Db,
  current: BankRecord,
  field: string,
  after: unknown,
  authorId: string,
  action: string,
  details: Record<string, unknown> | null = null,
): BankRecord {
  if (!field.startsWith("$")) throw new Error(`writeServiceChangeInTx: ${field}`);
  const at = new Date().toISOString();
  const version = current.version + 1;
  const updated = db
    .prepare("UPDATE record SET version = ?, updatedAt = ?, updatedBy = ? WHERE id = ? AND version = ?")
    .run(version, at, authorId, current.id, current.version);
  if (Number(updated.changes) === 0) throw versionConflict(db, getRecord(db, current.id) ?? current, current.version);
  const seq = Number(
    db
      .prepare("INSERT INTO record_history (recordId, version, field, before, after, authorId, at) VALUES (?, ?, ?, NULL, ?, ?, ?)")
      .run(current.id, version, field, JSON.stringify(after), authorId, at).lastInsertRowid,
  );
  const type = getRecordType(current.type);
  const caseId = type?.caseOf?.(recordContext(db, authorId, at), current) ?? null;
  writeJournal(db, action, current.id, authorId, at, { from: seq, to: seq }, details, caseId);
  return readRow(db, current.id);
}

/** Проверить версию Записи для маршрута предмета: устаревшая — version_conflict с изменениями (BANK-09). */
export function checkVersion(db: Db, current: BankRecord, expectedVersion: number): void {
  if (current.version !== expectedVersion) throw versionConflict(db, current, expectedVersion);
}

/**
 * Поставить (value = true) или снять метку Секрет: версия +1, строка истории «$secret», журнал
 * record.secret.mark или record.secret.unmark — одной транзакцией. Метка уже в нужном состоянии —
 * прежняя Запись без истории и журнала. Права — в таблице прав, а не здесь (research R1).
 */
export function setSecret(db: Db, id: string, request: { expectedVersion: number }, value: boolean, authorId: string): BankRecord {
  return inTransaction(db, () => {
    assertActor(db, authorId, value ? "record.secret.mark" : "record.secret.unmark");
    const current = getRecord(db, id);
    if (current === undefined) throw new ApiError("not_found", { id });
    if (current.version !== request.expectedVersion) throw versionConflict(db, current, request.expectedVersion);
    if (current.secret === value) return current;
    if (!value && getRecordType(current.type)?.secretLocked?.(current, db) === true) throw new ApiError("secret_crypto_task");
    if (!changeSecretInTx(db, current, value, authorId, authorId)) throw versionConflict(db, getRecord(db, id) ?? current, request.expectedVersion);
    return readRow(db, id);
  });
}

/**
 * Сменить метку Секрет внутри транзакции вызывающего — одна операция для правки человеком (ROLE-17,
 * ROLE-18) и автоматической метки по Словарю (ROLE-25): версия +1, updatedAt и updatedBy, строка
 * истории «$secret», журнал с Кейсом. journalActor — NULL, если метку ставит служба. Запись уже
 * изменили — false (оптимистическая блокировка).
 */
export function changeSecretInTx(
  db: Db,
  current: BankRecord,
  value: boolean,
  authorId: string,
  journalActor: string | null,
  details: Record<string, unknown> | null = null,
): boolean {
  const at = new Date().toISOString();
  const version = current.version + 1;
  const updated = db
    .prepare("UPDATE record SET secret = ?, version = ?, updatedAt = ?, updatedBy = ? WHERE id = ? AND version = ?")
    .run(value ? 1 : 0, version, at, authorId, current.id, current.version);
  if (Number(updated.changes) === 0) return false;
  const seq = writeSecretHistory(db, current.id, version, current.secret, value, authorId, at);
  const type = getRecordType(current.type);
  const caseId = type?.caseOf?.(recordContext(db, authorId, at), current) ?? null;
  writeJournal(db, value ? "record.secret.mark" : "record.secret.unmark", current.id, journalActor, at, { from: seq, to: seq }, details, caseId);
  return true;
}

function versionConflict(db: Db, current: BankRecord, expectedVersion: number): ApiError {
  const changesSince = getHistory(db, current.id).filter((item) => item.version > expectedVersion);
  return new ApiError("version_conflict", {}, { current, changesSince });
}

/** История Записи; Наблюдателю — без сквозных номеров строк (VIEW-59). */
export function getHistory(db: Db, id: string, reader?: Reader): HistoryItem[] {
  const numbered = seesSequenceNumbers(reader);
  return db
    .prepare("SELECT seq, version, field, before, after, authorId, at FROM record_history WHERE recordId = ? ORDER BY seq")
    .all(id)
    .map((row) => ({
      seq: numbered ? Number(row["seq"]) : null,
      version: Number(row["version"]),
      field: String(row["field"]),
      before: row["before"] === null ? null : (JSON.parse(String(row["before"])) as unknown),
      after: JSON.parse(String(row["after"])) as unknown,
      authorId: String(row["authorId"]),
      at: String(row["at"]),
    }));
}
