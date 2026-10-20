// T011 фичи 001, T002 фичи 002 — схема Банка в одном файле, только дописываемые история и журнал,
// один первый Старший; роли, состояния, метка Секрет и пределы числа Старших
// (BANK-04, BANK-07, ROLE-26, ROLE-03, ROLE-04, ROLE-35; ROLE-09 — роль в записи Члена Группы, а не
// Станции; research R8 фичи 001, R4 фичи 002). Схема 3 фичи 003 — журнал от имени службы и таблицы
// Сети (T003 фичи 003; data-model.md, research R10, R11). Схема 5 фичи 005 — Словарь, Местное
// расширение, Номера Кейсов (T008 фичи 005; data-model.md, research R17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { openDatabase, type Db } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrations.ts";

function freshBank(t: { after: (fn: () => void) => void }): Db {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-schema-"));
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db);
  return db;
}

function addMember(db: Db, options: { bootstrap?: boolean; role?: string; state?: string } = {}): string {
  const id = randomUUIDv7();
  db.prepare(
    "INSERT INTO member (id, label, role, state, createdAt, bootstrap) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, "У", options.role ?? "participant", options.state ?? "active", new Date().toISOString(), options.bootstrap === true ? 1 : 0);
  return id;
}

test("все таблицы Банка — в одном файле БД (BANK-04)", (t) => {
  const db = freshBank(t);
  const names = db
    .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table') ORDER BY name")
    .all()
    .map((r) => r["name"]);
  for (const name of ["meta", "member", "record", "record_history", "journal", "record_fts"]) {
    assert.ok(names.includes(name), `нет таблицы ${name}`);
  }
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()?.["value"], "6");
});

test("UPDATE и DELETE в record_history и journal прерываются (BANK-07)", (t) => {
  const db = freshBank(t);
  const author = addMember(db, { role: "senior" });
  const recordId = randomUUIDv7();
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy) VALUES (?, 'test.note', 1, '{}', ?, ?, ?, ?)",
  ).run(recordId, at, at, author, author);
  db.prepare(
    "INSERT INTO record_history (recordId, version, field, before, after, authorId, at) VALUES (?, 1, 'x', NULL, '\"v\"', ?, ?)",
  ).run(recordId, author, at);
  db.prepare(
    "INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES (?, ?, 'record.create', 'record', ?)",
  ).run(at, author, recordId);
  for (const table of ["record_history", "journal"]) {
    assert.throws(() => db.exec(`UPDATE ${table} SET at = 'y'`), /только дописывается/);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /только дописывается/);
  }
});

test("второй Член Группы с bootstrap = 1 отклоняется (ROLE-26)", (t) => {
  const db = freshBank(t);
  addMember(db, { bootstrap: true, role: "senior" });
  assert.throws(() => addMember(db, { bootstrap: true }), /UNIQUE/);
  addMember(db);
});

test("seq истории и журнала не переиспользуется (research R7)", (t) => {
  const db = freshBank(t);
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'journal'").get()?.["sql"];
  assert.match(String(sql), /seq INTEGER PRIMARY KEY AUTOINCREMENT/);
});

test("роль — одна из трёх, состояние — действует или отозван, версия ≥ 1 (ROLE-03, ROLE-08)", (t) => {
  const db = freshBank(t);
  addMember(db, { role: "senior" });
  for (const role of ["participant", "observer"]) addMember(db, { role });
  assert.throws(() => addMember(db, { role: "admin" }), /CHECK/);
  addMember(db, { state: "revoked" });
  assert.throws(() => addMember(db, { state: "lost" }), /CHECK/);
  const id = addMember(db);
  assert.equal(db.prepare("SELECT version FROM member WHERE id = ?").get(id)?.["version"], 1);
  assert.throws(() => db.prepare("UPDATE member SET version = 0 WHERE id = ?").run(id), /CHECK/);
});

test("метка Секрет — 0 или 1, по умолчанию 0 (ROLE-24)", (t) => {
  const db = freshBank(t);
  const author = addMember(db, { role: "senior" });
  const at = new Date().toISOString();
  const insert = (secret?: number) => {
    const id = randomUUIDv7();
    const columns = secret === undefined ? "" : ", secret";
    const values = secret === undefined ? "" : `, ${secret}`;
    db.prepare(
      `INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy${columns}) VALUES (?, 'test.note', 1, '{}', ?, ?, ?, ?${values})`,
    ).run(id, at, at, author, author);
    return id;
  };
  assert.equal(db.prepare("SELECT secret FROM record WHERE id = ?").get(insert())?.["secret"], 0);
  insert(1);
  assert.throws(() => insert(2), /CHECK/);
});

test("триггеры: действующих Старших не больше двух и не меньше одного (ROLE-04, ROLE-35)", (t) => {
  const db = freshBank(t);
  const s1 = addMember(db, { role: "senior", bootstrap: true });
  const s2 = addMember(db, { role: "senior" });
  assert.throws(() => addMember(db, { role: "senior" }), /Старших в Группе не больше двух/);
  const u1 = addMember(db);
  assert.throws(() => db.prepare("UPDATE member SET role = 'senior' WHERE id = ?").run(u1), /Старших в Группе не больше двух/);
  // Отозванный Старший не считается: третьего можно завести, когда один из двух отозван.
  db.prepare("UPDATE member SET state = 'revoked' WHERE id = ?").run(s2);
  db.prepare("UPDATE member SET role = 'senior' WHERE id = ?").run(u1);
  db.prepare("UPDATE member SET role = 'participant' WHERE id = ?").run(u1);
  assert.throws(() => db.prepare("UPDATE member SET role = 'participant' WHERE id = ?").run(s1), /без Старшего/);
  assert.throws(() => db.prepare("UPDATE member SET state = 'revoked' WHERE id = ?").run(s1), /без Старшего/);
});

// T003 фичи 003 — схема 3: журнал от имени службы и таблицы Сети (data-model.md; research R10, R11).

const KEY_A = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const KEY_B = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";

function addGroupKey(db: Db, current: number, reason = "install"): string {
  const id = randomUUIDv7();
  db.prepare(
    "INSERT INTO group_key (id, signingKey, encryptionKey, keyFingerprint, createdAt, reason, current) VALUES (?, ?, 'age1x', 'f', 't', ?, ?)",
  ).run(id, KEY_A, reason, current);
  return id;
}

test("журнал: автор может быть службой, предметы Сети разрешены", (t) => {
  const db = freshBank(t);
  const insert = (subjectType: string) =>
    db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES ('t', NULL, 'x', ?, 'x')").run(subjectType);
  for (const type of ["member", "record", "group-key", "registry", "coordinator-key"]) insert(type);
  // Схема 4 (T005 фичи 004): предметы Станций, Приглашений, Ретрансляторов и параметров Группы.
  for (const type of ["station", "invitation", "relay", "group-setting"]) insert(type);
  assert.throws(() => insert("packet"), /CHECK/);
});

test("group_key: ровно одна текущая строка, причина из трёх, строки не удаляются", (t) => {
  const db = freshBank(t);
  const first = addGroupKey(db, 1);
  assert.throws(() => addGroupKey(db, 1), /UNIQUE/);
  assert.throws(() => addGroupKey(db, 0, "stolen"), /CHECK/);
  db.prepare("UPDATE group_key SET current = 0 WHERE id = ?").run(first);
  addGroupKey(db, 1, "lost");
  assert.throws(() => db.prepare("UPDATE group_key SET signingKey = ? WHERE id = ?").run(KEY_B, first), /только дописывается/);
  assert.throws(() => db.prepare("DELETE FROM group_key WHERE id = ?").run(first), /только дописывается/);
});

test("coordinator_key: ключ уникален, у Члена Группы не больше одного registered", (t) => {
  const db = freshBank(t);
  const senior = addMember(db, { role: "senior" });
  const insert = (publicKey: string, state = "registered") =>
    db.prepare(
      "INSERT INTO coordinator_key (id, publicKey, keyFingerprint, memberId, state, registeredAt) VALUES (?, ?, 'f', ?, ?, 't')",
    ).run(randomUUIDv7(), publicKey, senior, state);
  insert(KEY_A);
  assert.throws(() => insert(KEY_B), /UNIQUE/);
  assert.throws(() => insert(KEY_A, "withdrawn"), /UNIQUE/);
  assert.throws(() => insert(KEY_B, "lost"), /CHECK/);
  db.prepare("UPDATE coordinator_key SET state = 'withdrawn', withdrawnAt = 't' WHERE publicKey = ?").run(KEY_A);
  insert(KEY_B);
  assert.throws(() => db.prepare("UPDATE coordinator_key SET state = 'registered' WHERE publicKey = ?").run(KEY_A), /только дописывается/);
});

test("registry_version: только дописывается, номер ≥ 1", (t) => {
  const db = freshBank(t);
  const senior = addMember(db, { role: "senior" });
  const insert = (number: number) =>
    db.prepare(
      "INSERT INTO registry_version (number, document, bodySha256, signedBy, appliedAt, appliedBy) VALUES (?, '{}', 'h', ?, 't', ?)",
    ).run(number, KEY_A, senior);
  insert(1);
  assert.throws(() => insert(0), /CHECK/);
  assert.throws(() => insert(1), /UNIQUE|PRIMARY/);
  assert.throws(() => db.exec("UPDATE registry_version SET document = '[]'"), /только дописывается/);
  assert.throws(() => db.exec("DELETE FROM registry_version"), /только дописывается/);
});

test("registry_conflict: менять можно только resolvedBy из NULL в номер", (t) => {
  const db = freshBank(t);
  const senior = addMember(db, { role: "senior" });
  const id = randomUUIDv7();
  db.prepare(
    "INSERT INTO registry_conflict (id, number, document, bodySha256, receivedAt, receivedBy) VALUES (?, 1, '{}', 'h', 't', ?)",
  ).run(id, senior);
  assert.throws(() => db.prepare("UPDATE registry_conflict SET document = '[]' WHERE id = ?").run(id), /только дописывается/);
  db.prepare("UPDATE registry_conflict SET resolvedBy = 2 WHERE id = ?").run(id);
  assert.throws(() => db.prepare("UPDATE registry_conflict SET resolvedBy = 3 WHERE id = ?").run(id), /только дописывается/);
  assert.throws(() => db.prepare("DELETE FROM registry_conflict WHERE id = ?").run(id), /только дописывается/);
});

// --- Схема 4 фичи 004 (T005; data-model.md «station», «invitation», «station_session», «group_setting») ---

function addInvitation(db: Db, memberId: string, issuedBy: string | null = null): string {
  const id = randomUUIDv7();
  db.prepare(
    "INSERT INTO invitation (id, memberId, issuedBy, issuedAt, expiresAt, passageKey, acceptKeyHash, state) VALUES (?, ?, ?, 't', 't', ?, 'h', 'issued')",
  ).run(id, memberId, issuedBy, `p-${id}`);
  return id;
}

function addStation(db: Db, memberId: string, publicKey = `k-${randomUUIDv7()}`): string {
  const id = randomUUIDv7();
  db.prepare(
    "INSERT INTO station (id, memberId, publicKey, keyFingerprint, invitationId, acceptedAt, state) VALUES (?, ?, ?, 'f', ?, 't', 'active')",
  ).run(id, memberId, publicKey, addInvitation(db, memberId));
  return id;
}

test("station: состояние active или revoked, причина отзыва из трёх, ключ уникален, строки не удаляются", (t) => {
  const db = freshBank(t);
  const m = addMember(db);
  const s = addStation(db, m, "k-same");
  assert.throws(() => addStation(db, m, "k-same"), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE station SET state = 'lost' WHERE id = ?").run(s), /CHECK/);
  assert.throws(() => db.prepare("UPDATE station SET state = 'revoked', revokeReason = 'gone' WHERE id = ?").run(s), /CHECK/);
  db.prepare("UPDATE station SET state = 'revoked', revokedAt = 't', revokeReason = 'handover', deleteOnlyUntil = 't2' WHERE id = ?").run(s);
  assert.throws(() => db.prepare("UPDATE station SET state = 'active' WHERE id = ?").run(s), /только дописывается|изменить/);
  assert.throws(() => db.prepare("UPDATE station SET deleteOnlyUntil = 't3' WHERE id = ?").run(s));
  db.prepare("UPDATE station SET deletionConfirmedAt = 't4' WHERE id = ?").run(s);
  assert.throws(() => db.prepare("UPDATE station SET deletionConfirmedAt = 't5' WHERE id = ?").run(s));
  assert.throws(() => db.prepare("DELETE FROM station WHERE id = ?").run(s));
  assert.throws(() => db.prepare("UPDATE station SET publicKey = 'x' WHERE id = ?").run(addStation(db, m)));
});

test("invitation: issued → used или cancelled; себе — только от CLI (issuedBy NULL)", (t) => {
  const db = freshBank(t);
  const m = addMember(db, { role: "senior" });
  assert.throws(() => addInvitation(db, m, m), /CHECK/);
  const fromCli = addInvitation(db, m, null);
  db.prepare("UPDATE invitation SET state = 'used', usedAt = 't' WHERE id = ?").run(fromCli);
  assert.throws(() => db.prepare("UPDATE invitation SET state = 'cancelled' WHERE id = ?").run(fromCli));
  const other = addInvitation(db, addMember(db), m);
  assert.throws(() => db.prepare("UPDATE invitation SET state = 'expired' WHERE id = ?").run(other));
  db.prepare("UPDATE invitation SET state = 'cancelled', cancelledAt = 't', cancelledBy = ? WHERE id = ?").run(m, other);
  assert.throws(() => db.prepare("DELETE FROM invitation WHERE id = ?").run(other));
});

test("station_session: хэш токена уникален, scope и причина конца — из перечня", (t) => {
  const db = freshBank(t);
  const s = addStation(db, addMember(db));
  const insert = db.prepare("INSERT INTO station_session (id, stationId, tokenHash, scope, startedAt, expiresAt) VALUES (?, ?, ?, ?, 't', 't')");
  insert.run(randomUUIDv7(), s, "h1", "full");
  assert.throws(() => insert.run(randomUUIDv7(), s, "h1", "full"), /UNIQUE/);
  assert.throws(() => insert.run(randomUUIDv7(), s, "h2", "admin"), /CHECK/);
  assert.throws(() => db.prepare("UPDATE station_session SET endReason = 'lost' WHERE tokenHash = 'h1'").run(), /CHECK/);
  db.prepare("UPDATE station_session SET endedAt = 't', endReason = 'expired' WHERE tokenHash = 'h1'").run();
});

test("group_setting: по умолчанию 72 часа и 90 дней, пределы 1 … 168 и 1 … 365", (t) => {
  const db = freshBank(t);
  const value = (key: string) => db.prepare("SELECT value FROM group_setting WHERE key = ?").get(key)?.["value"];
  assert.equal(value("invitationHours"), 72);
  assert.equal(value("deleteOnlyDays"), 90);
  assert.throws(() => db.prepare("UPDATE group_setting SET value = 169 WHERE key = 'invitationHours'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE group_setting SET value = 0 WHERE key = 'deleteOnlyDays'").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO group_setting (key, value) VALUES ('other', 1)").run(), /CHECK/);
  db.prepare("UPDATE group_setting SET value = 365 WHERE key = 'deleteOnlyDays'").run();
});

test("STATION-34: ни в одной таблице нет столбцов адресов", (t) => {
  const db = freshBank(t);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'record_fts%'").all();
  for (const { name } of tables) {
    for (const column of db.prepare(`PRAGMA table_info(${String(name)})`).all()) {
      assert.doesNotMatch(String(column["name"]), /ip|address|remote/i, `${String(name)}.${String(column["name"])}`);
    }
  }
});

// Фича 005, T008: схема 5 (data-model.md; BANK-30, DICT-13, DICT-45).

test("dictionary_version не правится и не удаляется", (t) => {
  const db = freshBank(t);
  db.prepare("INSERT INTO dictionary_version (number, document, bodySha256, signedBy, appliedAt, appliedBy) VALUES (1, 'd', 'h', 'p', 't', NULL)").run();
  assert.throws(() => db.exec("UPDATE dictionary_version SET document = 'z'"));
  assert.throws(() => db.exec("DELETE FROM dictionary_version"));
});

test("dict_element: уровень и состояние из перечня, «поглощён» требует канон", (t) => {
  const db = freshBank(t);
  const insert = db.prepare("INSERT INTO dict_element (id, code, label, kind, level, state, canonicalId, sinceVersion, props) VALUES (?, ?, 'x', 'indicator_type', ?, ?, ?, 1, '{}')");
  insert.run("e1", "x1", "network", "active", null);
  insert.run("e2", "A:x2", "local", "deprecated", null);
  assert.throws(() => insert.run("e3", "x3", "group", "active", null), /CHECK/);
  assert.throws(() => insert.run("e4", "x4", "network", "removed", null), /CHECK/);
  assert.throws(() => insert.run("e5", "x5", "network", "absorbed", null), /CHECK/);
  insert.run("e6", "x6", "network", "absorbed", "e1");
});

test("stop_list_entry: вид из трёх, у строки «Местного» пояснение непустое", (t) => {
  const db = freshBank(t);
  db.prepare("INSERT INTO stop_list (id, code, label, source, builtAt, rows, level) VALUES ('n', 'common_defaults', 'x', 'x', 'x', 0, 'network')").run();
  db.prepare("INSERT INTO stop_list (id, code, label, source, builtAt, rows, level) VALUES ('l', 'A:local', 'Местное', 'Группа', 'x', 0, 'local')").run();
  const insert = db.prepare("INSERT INTO stop_list_entry (id, listId, typeId, kind, value, normalized, note) VALUES (?, ?, 't', ?, 'v', 'v', ?)");
  insert.run("1", "n", "value", "п");
  insert.run("2", "n", "range", "п");
  insert.run("3", "n", "pattern", "п");
  assert.throws(() => insert.run("4", "n", "regex", "п"), /CHECK/);
  assert.throws(() => insert.run("5", "l", "value", ""), /пояснение|CHECK/);
  insert.run("6", "l", "value", "п");
});

test("local_proposal: переходы только из «предложено», отклонение — с причиной", (t) => {
  const db = freshBank(t);
  const m = addMember(db);
  const s = addMember(db, { role: "senior" });
  const insert = db.prepare("INSERT INTO local_proposal (id, kind, payload, state, proposedBy, proposedAt) VALUES (?, 'type', '{}', 'proposed', ?, 't')");
  insert.run("p1", m);
  insert.run("p2", m);
  assert.throws(() => db.prepare("UPDATE local_proposal SET state = 'rejected', decidedBy = ?, decidedAt = 't' WHERE id = 'p1'").run(s), /CHECK/);
  db.prepare("UPDATE local_proposal SET state = 'rejected', decidedBy = ?, decidedAt = 't', reason = 'x' WHERE id = 'p1'").run(s);
  assert.throws(() => db.prepare("UPDATE local_proposal SET state = 'accepted' WHERE id = 'p1'").run());
  db.prepare("UPDATE local_proposal SET state = 'accepted', decidedBy = ?, decidedAt = 't' WHERE id = 'p2'").run(s);
  assert.throws(() => db.prepare("INSERT INTO local_proposal (id, kind, payload, state, proposedBy, proposedAt) VALUES ('p3', 'other', '{}', 'proposed', ?, 't')").run(m), /CHECK/);
  assert.throws(() => db.prepare("DELETE FROM local_proposal WHERE id = 'p2'").run());
});

test("case_number: Номер и Кейс уникальны, строки не удаляются; счётчик не уменьшается", (t) => {
  const db = freshBank(t);
  const insert = db.prepare("INSERT INTO case_number (number, caseId, year, seq) VALUES (?, ?, 2026, ?)");
  insert.run("2026-001", "c1", 1);
  assert.throws(() => insert.run("2026-001", "c2", 1), /UNIQUE/);
  assert.throws(() => insert.run("2026-002", "c1", 2), /UNIQUE/);
  assert.throws(() => db.exec("DELETE FROM case_number"));
  db.prepare("INSERT INTO case_number_counter (year, last) VALUES (2026, 5)").run();
  db.prepare("UPDATE case_number_counter SET last = 6 WHERE year = 2026").run();
  assert.throws(() => db.prepare("UPDATE case_number_counter SET last = 4 WHERE year = 2026").run());
  assert.throws(() => db.exec("DELETE FROM case_number_counter"));
});
