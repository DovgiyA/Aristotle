// T007 — миграция схемы Банка 4 → 5: журнал получает колонку caseId и предметы Словаря и Местного
// расширения; таблицы Словаря, Местного расширения, Номеров Кейсов и производного; без потерь
// (research R17 фичи 005; BANK-05, BANK-07, INBOX-32).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { openDatabase, type Db } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrations.ts";

function bankV4(t: { after: (fn: () => void) => void }): Db {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, undefined, { target: 4 });
  const senior = randomUUIDv7();
  const participant = randomUUIDv7();
  const at = new Date().toISOString();
  const member = db.prepare("INSERT INTO member (id, label, role, state, createdAt, bootstrap) VALUES (?, ?, ?, 'active', ?, ?)");
  member.run(senior, "С1", "senior", at, 1);
  member.run(participant, "У1", "participant", at, 0);
  const journal = db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, ?, ?, ?)");
  journal.run(at, senior, "member.bootstrap", "member", senior, '{"via":"cli-init"}');
  for (const secret of [0, 1]) {
    const id = randomUUIDv7();
    db.prepare(
      "INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, 'test.note', 1, '{\"x\":\"v\"}', ?, ?, ?, ?, ?)",
    ).run(id, at, at, participant, participant, secret);
    journal.run(at, participant, "record.create", "record", id, null);
  }
  db.prepare("INSERT INTO registry_version (number, document, bodySha256, signedBy, appliedAt, appliedBy) VALUES (1, 'd1', 'h1', 'p', ?, NULL)").run(at);
  journal.run(at, null, "station.accept", "station", "s", null);
  return db;
}

const schemaVersion = (db: Db) => Number(db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()?.["value"]);
const dump = (db: Db, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const TABLES = ["member", "record", "registry_version"];
const NEW_TABLES = [
  "dictionary_version",
  "dict_element",
  "dict_template",
  "stop_list",
  "stop_list_entry",
  "local_override",
  "local_proposal",
  "case_number_counter",
  "case_number",
  "record_case",
  "indicator_value",
];
const shape = (db: Db) =>
  ["table", "index", "trigger"].map((type) =>
    db.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type).map((r) => r["name"]),
  );

test("Банк схемы 4 мигрирует в схему 5 без потерь", (t) => {
  const db = bankV4(t);
  const before = Object.fromEntries(TABLES.map((name) => [name, dump(db, name)]));
  const journalBefore = dump(db, "journal");
  const maxSeq = Number(db.prepare("SELECT max(seq) AS m FROM journal").get()?.["m"]);
  migrate(db, undefined, { target: 5 });
  assert.equal(schemaVersion(db), 5);
  assert.deepEqual(Object.fromEntries(TABLES.map((name) => [name, dump(db, name)])), before);
  // Строки журнала те же, с caseId = NULL.
  assert.deepEqual(
    dump(db, "journal").map((row) => ({ ...row })),
    journalBefore.map((row) => ({ ...row, caseId: null })),
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
  const seq = db
    .prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, caseId) VALUES ('t', NULL, 'dictionary.apply', 'dictionary', '1', NULL)")
    .run().lastInsertRowid;
  assert.equal(Number(seq), maxSeq + 1);
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES ('t', NULL, 'x', 'local-extension', 'x')").run();
  for (const table of NEW_TABLES) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table), `нет таблицы ${table}`);
  }
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'journal_case'").get(), "нет индекса journal (caseId, seq)");
  assert.throws(() => db.exec("DELETE FROM journal"), /только дописывается/);
});

test("повторная миграция 4 → 5 ничего не меняет", (t) => {
  const db = bankV4(t);
  migrate(db, undefined, { target: 5 });
  const before = { journal: dump(db, "journal"), shape: shape(db) };
  migrate(db, undefined, { target: 5 });
  assert.equal(schemaVersion(db), 5);
  assert.deepEqual({ journal: dump(db, "journal"), shape: shape(db) }, before);
});

test("сбой посреди миграции 4 → 5 оставляет схему 4 целиком", (t) => {
  const db = bankV4(t);
  const journal = dump(db, "journal");
  assert.throws(
    () =>
      migrate(db, undefined, {
        target: 5,
        faults: {
          duringV5: () => {
            throw new Error("сбой");
          },
        },
      }),
    /сбой/,
  );
  assert.equal(schemaVersion(db), 4);
  assert.deepEqual(dump(db, "journal"), journal);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'dictionary_version'").get(), undefined);
});

test("схема нового Банка совпадает со схемой мигрированного из схемы 4", (t) => {
  const migrated = bankV4(t);
  migrate(migrated, undefined, { target: 5 });
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const fresh = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    fresh.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const never = () => {
    throw new Error("новый Банк не должен перестраиваться");
  };
  migrate(fresh, undefined, { target: 5, faults: { duringV2: never, duringV3: never, duringV4: never, duringV5: never } });
  assert.equal(schemaVersion(fresh), 5);
  assert.deepEqual(shape(fresh), shape(migrated));
});
