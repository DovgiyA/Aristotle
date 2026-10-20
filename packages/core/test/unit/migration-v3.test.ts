// T002 фичи 003 — миграция схемы Банка 2 → 3: журнал допускает автора «служба Опорной станции»
// (actorId = NULL) и предметы Сети, новые таблицы Сети; без потерь журнала (research R11;
// BANK-05, BANK-07).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { openDatabase, type Db } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrations.ts";

function bankV2(t: { after: (fn: () => void) => void }): { db: Db; senior: string } {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, undefined, { target: 2 });
  const senior = randomUUIDv7();
  const participant = randomUUIDv7();
  const at = new Date().toISOString();
  const member = db.prepare("INSERT INTO member (id, label, role, state, createdAt, bootstrap) VALUES (?, ?, ?, 'active', ?, ?)");
  member.run(senior, "С1", "senior", at, 1);
  member.run(participant, "У1", "participant", at, 0);
  const record = db.prepare(
    "INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, 'test.note', 1, '{\"x\":\"v\"}', ?, ?, ?, ?, ?)",
  );
  const history = db.prepare(
    "INSERT INTO record_history (recordId, version, field, before, after, authorId, at) VALUES (?, 1, 'x', NULL, '\"v\"', ?, ?)",
  );
  const journal = db.prepare(
    "INSERT INTO journal (at, actorId, action, subjectType, subjectId, historyFrom, historyTo, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  journal.run(at, senior, "member.bootstrap", "member", senior, null, null, '{"via":"cli-init"}');
  journal.run(at, senior, "member.create", "member", participant, null, null, '{"role":"participant"}');
  for (const secret of [0, 1]) {
    const id = randomUUIDv7();
    record.run(id, at, at, participant, participant, secret);
    const seq = Number(history.run(id, participant, at).lastInsertRowid);
    journal.run(at, participant, "record.create", "record", id, seq, seq, null);
  }
  return { db, senior };
}

function schemaVersion(db: Db): number {
  return Number(db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()?.["value"]);
}

function dump(db: Db, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function schemaShape(db: Db): unknown {
  const rows = (type: string) =>
    db
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all(type)
      .map((r) => r["name"]);
  return { tables: rows("table"), indexes: rows("index"), triggers: rows("trigger"), journal: db.prepare("PRAGMA table_info(journal)").all() };
}

test("Банк схемы 2 мигрирует в схему 3 без потерь журнала", (t) => {
  const { db } = bankV2(t);
  const before = {
    member: dump(db, "member"),
    record: dump(db, "record"),
    history: dump(db, "record_history"),
    journal: dump(db, "journal"),
  };
  const maxSeq = Number(db.prepare("SELECT max(seq) AS m FROM journal").get()?.["m"]);
  migrate(db, undefined, { target: 3 });
  assert.equal(schemaVersion(db), 3);
  assert.deepEqual(
    { member: dump(db, "member"), record: dump(db, "record"), history: dump(db, "record_history"), journal: dump(db, "journal") },
    before,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
  // Нумерация журнала продолжается: sqlite_sequence переехал вместе с таблицей.
  const seq = db
    .prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES ('t', NULL, 'group-key.create', 'group-key', 'x')")
    .run().lastInsertRowid;
  assert.equal(Number(seq), maxSeq + 1);
  for (const table of ["group_key", "coordinator_key", "registry_version", "registry_conflict"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table), `нет таблицы ${table}`);
  }
  assert.throws(() => db.exec("DELETE FROM journal"), /только дописывается/);
});

test("повторная миграция 2 → 3 ничего не меняет", (t) => {
  const { db } = bankV2(t);
  migrate(db, undefined, { target: 3 });
  const before = { journal: dump(db, "journal"), shape: schemaShape(db) };
  migrate(db, undefined, { target: 3 });
  assert.equal(schemaVersion(db), 3);
  assert.deepEqual({ journal: dump(db, "journal"), shape: schemaShape(db) }, before);
});

test("сбой посреди миграции 2 → 3 оставляет схему 2 целиком", (t) => {
  const { db } = bankV2(t);
  const journal = dump(db, "journal");
  assert.throws(
    () =>
      migrate(db, undefined, {
        target: 3,
        faults: {
          duringV3: () => {
            throw new Error("сбой");
          },
        },
      }),
    /сбой/,
  );
  assert.equal(schemaVersion(db), 2);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
  assert.deepEqual(dump(db, "journal"), journal);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'group_key'").get(), undefined);
  assert.throws(
    () => db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES ('t', NULL, 'x', 'member', 'x')").run(),
    /NOT NULL/,
  );
});

test("новый Банк — сразу схема 3: перестройки 1 → 2 и 2 → 3 не выполняются", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const never = () => {
    throw new Error("новый Банк не должен перестраиваться");
  };
  migrate(db, undefined, { target: 3, faults: { duringV2: never, duringV3: never } });
  assert.equal(schemaVersion(db), 3);
});

test("схема нового Банка совпадает со схемой мигрированного из схемы 2", (t) => {
  const { db: migrated } = bankV2(t);
  migrate(migrated, undefined, { target: 3 });
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const fresh = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    fresh.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(fresh, undefined, { target: 3 });
  assert.deepEqual(schemaShape(fresh), schemaShape(migrated));
});
