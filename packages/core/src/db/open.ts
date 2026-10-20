// Прослойка БД: весь доступ ядра к SQLite идёт только через openDatabase()
// (APP-30; research R2, R6). Запасной драйвер better-sqlite3 подключается заменой этого файла.
import * as sqlite from "node:sqlite";
import { message } from "@aristotel/protocol";

export type Db = sqlite.DatabaseSync;

type DatabaseClass = new (path: string) => Db;

/**
 * Класс БД: в Node 26.11+ — Database, в Node 24 — DatabaseSync
 * (в 26 DatabaseSync — устаревший псевдоним, DEP0210).
 */
export function pickDatabaseClass<C>(mod: { Database?: C; DatabaseSync?: C }): C {
  const cls = mod.Database ?? mod.DatabaseSync;
  if (cls === undefined) throw new Error(message("sqlite_class_missing"));
  return cls;
}

/** Открыть файл БД Банка с прагмами стойкости к аварийной остановке. */
export function openDatabase(path: string): Db {
  const Database = pickDatabaseClass(sqlite as unknown as { Database?: DatabaseClass; DatabaseSync?: DatabaseClass });
  const db = new Database(path);
  // Ожидание блокировки — первым: иначе переключение в WAL, когда файл БД одновременно открывает
  // другой процесс (два init), сразу падает с «database is locked».
  db.exec("PRAGMA busy_timeout = 5000");
  // Флаг defensive закрывает средства SQL, которыми можно испортить файл БД.
  db.enableDefensive(true);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * Выполнить fn одной транзакцией BEGIN IMMEDIATE: блокировка записи берётся сразу,
 * при исключении всё откатывается (BANK-05).
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** Штатное закрытие: WAL сливается в основной файл БД (research R6). */
export function closeDatabase(db: Db): void {
  if (!db.isOpen) return;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}
