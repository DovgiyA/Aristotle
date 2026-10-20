// T004 фичи 004 — миграция схемы Банка 3 → 4: журнал принимает предметы Станций, Приглашений,
// Ретрансляторов и параметров Группы; Реестр допускает автора-службу; новые таблицы Станций; без
// потерь (research R18; BANK-05, BANK-07).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { openDatabase, type Db } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrations.ts";

function bankV3(t: { after: (fn: () => void) => void }): Db {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, undefined, { target: 3 });
  const senior = randomUUIDv7();
  const participant = randomUUIDv7();
  const at = new Date().toISOString();
  const member = db.prepare("INSERT INTO member (id, label, role, state, createdAt, bootstrap) VALUES (?, ?, ?, 'active', ?, ?)");
  member.run(senior, "С1", "senior", at, 1);
  member.run(participant, "У1", "participant", at, 0);
  const journal = db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, ?, ?, ?)");
  journal.run(at, senior, "member.bootstrap", "member", senior, '{"via":"cli-init"}');
  journal.run(at, null, "group-key.create", "group-key", "k", '{"reason":"install"}');
  for (const secret of [0, 1]) {
    const id = randomUUIDv7();
    db.prepare(
      "INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, 'test.note', 1, '{\"x\":\"v\"}', ?, ?, ?, ?, ?)",
    ).run(id, at, at, participant, participant, secret);
    journal.run(at, participant, "record.create", "record", id, null);
  }
  db.prepare("INSERT INTO group_key (id, signingKey, encryptionKey, keyFingerprint, createdAt, reason, current) VALUES ('k', 's', 'e', 'f', ?, 'install', 1)").run(at);
  db.prepare("INSERT INTO coordinator_key (id, publicKey, keyFingerprint, memberId, state, registeredAt) VALUES ('c', 'p', 'f', ?, 'registered', ?)").run(senior, at);
  db.prepare("INSERT INTO registry_version (number, document, bodySha256, signedBy, appliedAt, appliedBy) VALUES (1, 'd1', 'h1', 'p', ?, ?)").run(at, senior);
  db.prepare("INSERT INTO registry_conflict (id, number, document, bodySha256, receivedAt, receivedBy) VALUES ('x', 1, 'd2', 'h2', ?, ?)").run(at, senior);
  return db;
}

const schemaVersion = (db: Db) => Number(db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()?.["value"]);
const dump = (db: Db, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const TABLES = ["member", "record", "journal", "group_key", "coordinator_key", "registry_version", "registry_conflict"];
const shape = (db: Db) =>
  ["table", "index", "trigger"].map((type) =>
    db.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type).map((r) => r["name"]),
  );

test("Банк схемы 3 мигрирует в схему 4 без потерь", (t) => {
  const db = bankV3(t);
  const before = Object.fromEntries(TABLES.map((name) => [name, dump(db, name)]));
  const maxSeq = Number(db.prepare("SELECT max(seq) AS m FROM journal").get()?.["m"]);
  migrate(db, undefined, { target: 4 });
  assert.equal(schemaVersion(db), 4);
  assert.deepEqual(Object.fromEntries(TABLES.map((name) => [name, dump(db, name)])), before);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
  const seq = db
    .prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES ('t', NULL, 'station.accept', 'station', 's')")
    .run().lastInsertRowid;
  assert.equal(Number(seq), maxSeq + 1);
  for (const subject of ["invitation", "relay", "group-setting"]) {
    db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES ('t', NULL, 'x', ?, 'x')").run(subject);
  }
  db.prepare("INSERT INTO registry_version (number, document, bodySha256, signedBy, appliedAt, appliedBy) VALUES (2, 'd', 'h', 'p', 't', NULL)").run();
  db.prepare("INSERT INTO registry_conflict (id, number, document, bodySha256, receivedAt, receivedBy) VALUES ('y', 2, 'd', 'h', 't', NULL)").run();
  for (const table of ["station", "invitation", "station_session", "group_setting"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table), `нет таблицы ${table}`);
  }
  assert.throws(() => db.exec("DELETE FROM journal"), /только дописывается/);
  assert.throws(() => db.exec("UPDATE registry_version SET document = 'z'"));
});

test("повторная миграция 3 → 4 ничего не меняет", (t) => {
  const db = bankV3(t);
  migrate(db, undefined, { target: 4 });
  const before = { journal: dump(db, "journal"), shape: shape(db) };
  migrate(db, undefined, { target: 4 });
  assert.equal(schemaVersion(db), 4);
  assert.deepEqual({ journal: dump(db, "journal"), shape: shape(db) }, before);
});

test("сбой посреди миграции 3 → 4 оставляет схему 3 целиком", (t) => {
  const db = bankV3(t);
  const journal = dump(db, "journal");
  assert.throws(
    () =>
      migrate(db, undefined, {
        faults: {
          duringV4: () => {
            throw new Error("сбой");
          },
        },
      }),
    /сбой/,
  );
  assert.equal(schemaVersion(db), 3);
  assert.deepEqual(dump(db, "journal"), journal);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'station'").get(), undefined);
  assert.throws(() => db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES ('t', NULL, 'x', 'station', 'x')").run());
});

test("схема нового Банка совпадает со схемой мигрированного из схемы 3", (t) => {
  const migrated = bankV3(t);
  migrate(migrated, undefined, { target: 4 });
  const dir = mkdtempSync(join(tmpdir(), "aristotel-migration-"));
  const fresh = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    fresh.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const never = () => {
    throw new Error("новый Банк не должен перестраиваться");
  };
  migrate(fresh, undefined, { target: 4, faults: { duringV2: never, duringV3: never, duringV4: never } });
  assert.equal(schemaVersion(fresh), 4);
  assert.deepEqual(shape(fresh), shape(migrated));
  assert.deepEqual(
    fresh.prepare("SELECT key, value FROM group_setting ORDER BY key").all().map((r) => [r["key"], r["value"]]),
    [["deleteOnlyDays", 90], ["invitationHours", 72]],
  );
});
