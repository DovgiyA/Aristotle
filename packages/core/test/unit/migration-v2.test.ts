// T001 — миграция схемы Банка 1 → 2: перестройка member, столбец record.secret, без потерь истории
// и журнала (research R5; BANK-05, BANK-07). С фичи 003 миграция по умолчанию идёт до схемы 3 —
// здесь цель задана явно: схема 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { openDatabase, type Db } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrations.ts";

function bankV1(t: { after: (fn: () => void) => void }): { db: Db; senior: string; recordId: string } {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, undefined, { target: 1 });
  const senior = randomUUIDv7();
  const recordId = randomUUIDv7();
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO member (id, label, role, state, createdAt, bootstrap) VALUES (?, 'С1', 'senior', 'active', ?, 1)",
  ).run(senior, at);
  db.prepare(
    "INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy) VALUES (?, 'test.note', 1, '{\"x\":\"v\"}', ?, ?, ?, ?)",
  ).run(recordId, at, at, senior, senior);
  db.prepare(
    "INSERT INTO record_history (recordId, version, field, before, after, authorId, at) VALUES (?, 1, 'x', NULL, '\"v\"', ?, ?)",
  ).run(recordId, senior, at);
  db.prepare(
    "INSERT INTO journal (at, actorId, action, subjectType, subjectId, historyFrom, historyTo) VALUES (?, ?, 'record.create', 'record', ?, 1, 1)",
  ).run(at, senior, recordId);
  return { db, senior, recordId };
}

function schemaVersion(db: Db): number {
  return Number(db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()?.["value"]);
}

function dump(db: Db, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

test("Банк схемы 1 мигрирует в схему 2 без потерь", (t) => {
  const { db, senior, recordId } = bankV1(t);
  const history = dump(db, "record_history");
  const journal = dump(db, "journal");
  migrate(db, undefined, { target: 2 });
  assert.equal(schemaVersion(db), 2);
  const member = db.prepare("SELECT * FROM member WHERE id = ?").get(senior);
  assert.equal(member?.["version"], 1);
  assert.equal(member?.["role"], "senior");
  assert.equal(member?.["bootstrap"], 1);
  assert.equal(db.prepare("SELECT secret FROM record WHERE id = ?").get(recordId)?.["secret"], 0);
  assert.deepEqual(dump(db, "record_history"), history);
  assert.deepEqual(dump(db, "journal"), journal);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
  // Новые роли принимаются, ссылки на member по-прежнему проверяются.
  db.prepare(
    "INSERT INTO member (id, label, role, state, createdAt) VALUES (?, 'Н1', 'observer', 'active', ?)",
  ).run(randomUUIDv7(), new Date().toISOString());
  assert.throws(() =>
    db.prepare(
      "INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES ('t', ?, 'record.update', 'record', ?)",
    ).run(randomUUIDv7(), recordId),
  /FOREIGN KEY/);
});

test("повторная миграция ничего не меняет", (t) => {
  const { db } = bankV1(t);
  migrate(db, undefined, { target: 2 });
  const before = { member: dump(db, "member"), record: dump(db, "record"), journal: dump(db, "journal") };
  migrate(db, undefined, { target: 2 });
  assert.equal(schemaVersion(db), 2);
  assert.deepEqual({ member: dump(db, "member"), record: dump(db, "record"), journal: dump(db, "journal") }, before);
});

test("сбой посреди миграции оставляет схему 1 целиком", (t) => {
  const { db, senior } = bankV1(t);
  assert.throws(() =>
    migrate(db, undefined, {
      target: 2,
      faults: {
        duringV2: () => {
          throw new Error("сбой");
        },
      },
    }),
  /сбой/);
  assert.equal(schemaVersion(db), 1);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
  assert.equal(db.prepare("SELECT role FROM member WHERE id = ?").get(senior)?.["role"], "senior");
  assert.throws(() =>
    db.prepare("INSERT INTO member (id, label, role, state, createdAt) VALUES (?, 'У1', 'participant', 'active', 't')").run(
      randomUUIDv7(),
    ),
  /CHECK/);
  const columns = db.prepare("PRAGMA table_info(record)").all().map((c) => c["name"]);
  assert.ok(!columns.includes("secret"));
});

// T049 — новый Банк создаётся сразу схемой 2, без перестройки member (research R5), и его схема
// совпадает со схемой Банка, мигрированного из схемы 1.
function schemaShape(db: Db): unknown {
  const names = (type: string) =>
    db.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type).map((r) => r["name"]);
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all();
  return {
    tables: names("table"),
    indexes: names("index"),
    triggers: names("trigger"),
    member: columns("member"),
    record: columns("record"),
  };
}

test("новый Банк — сразу схема 2: шаг перестройки 1 → 2 не выполняется", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, undefined, {
    target: 2,
    faults: {
      duringV2: () => {
        throw new Error("новый Банк не должен перестраивать member");
      },
    },
  });
  assert.equal(schemaVersion(db), 2);
});

test("схема нового Банка совпадает со схемой мигрированного", (t) => {
  const { db: migrated } = bankV1(t);
  migrate(migrated, undefined, { target: 2 });
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const fresh = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    fresh.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(fresh, undefined, { target: 2 });
  assert.deepEqual(schemaShape(fresh), schemaShape(migrated));
});
