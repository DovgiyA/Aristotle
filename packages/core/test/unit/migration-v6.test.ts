// T006 — миграция схемы Банка 5 → 6: таблицы Материалов (research R11 фичи 006; data-model.md
// «Таблицы схемы 6»); прежние данные не трогаются, сбой посреди миграции оставляет схему 5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { openDatabase, type Db } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrations.ts";

function bank(t: { after: (fn: () => void) => void }, target?: number): Db {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, undefined, target === undefined ? {} : { target });
  return db;
}

function fill(db: Db): void {
  const member = randomUUIDv7();
  const at = new Date().toISOString();
  db.prepare("INSERT INTO member (id, label, role, state, createdAt, bootstrap) VALUES (?, 'У1', 'participant', 'active', ?, 0)").run(member, at);
  const id = randomUUIDv7();
  db.prepare("INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, 'test.note', 1, '{\"x\":\"v\"}', ?, ?, ?, ?, 0)").run(id, at, at, member, member);
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, caseId) VALUES (?, ?, 'record.create', 'record', ?, NULL)").run(at, member, id);
}

const schemaVersion = (db: Db) => Number(db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()?.["value"]);
const dump = (db: Db, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const shape = (db: Db) =>
  ["table", "index", "trigger"].map((type) => db.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type).map((r) => r["name"]));
const NEW_TABLES = ["material_state", "material_attestation", "material_upload"];

test("Банк схемы 5 мигрирует в схему 6 без потерь", (t) => {
  const db = bank(t, 5);
  fill(db);
  const before = ["member", "record", "journal"].map((name) => dump(db, name));
  migrate(db);
  assert.equal(schemaVersion(db), 6);
  assert.deepEqual(["member", "record", "journal"].map((name) => dump(db, name)), before);
  for (const table of NEW_TABLES) assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table), `нет таблицы ${table}`);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("material_state: доставка — pending | delivered, путь уникален в владельце, ссылка на Запись", (t) => {
  const db = bank(t);
  const member = randomUUIDv7();
  const at = new Date().toISOString();
  db.prepare("INSERT INTO member (id, label, role, state, createdAt, bootstrap) VALUES (?, 'У1', 'participant', 'active', ?, 0)").run(member, at);
  const record = (id: string) =>
    db.prepare("INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, 'material', 1, '{}', ?, ?, ?, ?, 0)").run(id, at, at, member, member);
  const state = db.prepare("INSERT INTO material_state (id, ownerType, ownerId, pathKey, delivery, currentAttestation) VALUES (?, 'case', 'c', ?, ?, 1)");
  const a = randomUUIDv7();
  const b = randomUUIDv7();
  record(a);
  record(b);
  state.run(a, "x.img", "pending");
  assert.throws(() => state.run(b, "x.img", "pending"), /UNIQUE/);
  assert.throws(() => state.run(b, "y.img", "lost"), /CHECK/);
  assert.throws(() => state.run(randomUUIDv7(), "z.img", "pending"), /FOREIGN KEY/);
  db.prepare("INSERT INTO material_state (id, ownerType, ownerId, pathKey, delivery, currentAttestation) VALUES (?, 'case', 'другой', 'x.img', 'pending', 1)").run(b);
});

test("повторная миграция ничего не меняет", (t) => {
  const db = bank(t, 5);
  migrate(db);
  const before = shape(db);
  migrate(db);
  assert.equal(schemaVersion(db), 6);
  assert.deepEqual(shape(db), before);
});

test("сбой посреди миграции 5 → 6 оставляет схему 5 целиком", (t) => {
  const db = bank(t, 5);
  fill(db);
  const journal = dump(db, "journal");
  assert.throws(() => migrate(db, undefined, { faults: { duringV6: () => { throw new Error("сбой"); } } }), /сбой/);
  assert.equal(schemaVersion(db), 5);
  assert.deepEqual(dump(db, "journal"), journal);
  for (const table of NEW_TABLES) assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(table), undefined);
});

test("схема нового Банка совпадает со схемой мигрированного из схемы 5", (t) => {
  const migrated = bank(t, 5);
  migrate(migrated);
  const never = () => {
    throw new Error("новый Банк не должен перестраиваться");
  };
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const fresh = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    fresh.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(fresh, undefined, { faults: { duringV2: never, duringV3: never, duringV4: never, duringV5: never, duringV6: never } });
  assert.equal(schemaVersion(fresh), 6);
  assert.deepEqual(shape(fresh), shape(migrated));
});
