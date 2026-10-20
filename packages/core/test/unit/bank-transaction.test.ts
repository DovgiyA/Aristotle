// T037 — изменение, история, журнал и индекс — одна транзакция в одном файле БД
// (BANK-04, BANK-05, BANK-07).
// Журнал в проверках — записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { startTestService } from "../../../../tests/support/harness.ts";
import { createRecord, getRecord, updateRecord } from "../../src/bank/records.ts";

function counts(db: import("../../src/db/open.ts").Db) {
  const n = (sql: string) => Number(db.prepare(sql).get()?.["n"]);
  return {
    history: n("SELECT count(*) AS n FROM record_history"),
    journal: n("SELECT count(*) AS n FROM journal WHERE actorId IS NOT NULL"),
    fts: n("SELECT count(*) AS n FROM record_fts WHERE record_fts MATCH 'w'"),
  };
}

test("сбой после записи истории откатывает Запись, историю, журнал и индекс (BANK-05)", async (t) => {
  const svc = await startTestService(t);
  const record = createRecord(svc.db, { type: "test.note", fields: { x: "v" } }, svc.seniorId);
  const before = counts(svc.db);
  assert.throws(
    () =>
      updateRecord(svc.db, record.id, { expectedVersion: 1, fields: { x: "w" } }, svc.seniorId, {
        afterHistory: () => {
          throw new Error("внедрённый сбой");
        },
      }),
    /внедрённый сбой/,
  );
  assert.deepEqual(counts(svc.db), before);
  assert.deepEqual(getRecord(svc.db, record.id)?.fields, { x: "v" });
  assert.equal(getRecord(svc.db, record.id)?.version, 1);
  assert.equal(svc.db.isTransaction, false);
});

test("x: v → w — строка истории «было v — стало w» с автором и временем (BANK-07)", async (t) => {
  const svc = await startTestService(t);
  const record = createRecord(svc.db, { type: "test.note", fields: { x: "v" } }, svc.seniorId);
  updateRecord(svc.db, record.id, { expectedVersion: 1, fields: { x: "w" } }, svc.seniorId);
  const row = svc.db
    .prepare("SELECT field, before, after, authorId, at FROM record_history WHERE recordId = ? AND version = 2")
    .get(record.id);
  assert.equal(row?.["field"], "x");
  assert.equal(JSON.parse(String(row?.["before"])), "v");
  assert.equal(JSON.parse(String(row?.["after"])), "w");
  assert.equal(row?.["authorId"], svc.seniorId);
  assert.ok(!Number.isNaN(Date.parse(String(row?.["at"]))));
  assert.equal(counts(svc.db).fts, 1);
});

test("Записи, история, журнал и индекс — в одном файле БД (BANK-04)", async (t) => {
  const svc = await startTestService(t);
  createRecord(svc.db, { type: "test.note", fields: { x: "v" } }, svc.seniorId);
  // group-key.json — секретная часть Ключа Группы, нарочно вне БД (BANK-52; фича 003, research R3);
  // tls-key.pem и tls-cert.pem — TLS-ключ Опорной станции, тоже вне БД (BANK-52; фича 004, research R2).
  const outside = ["install.json", "access-token", "group-key.json", "tls-key.pem", "tls-cert.pem"];
  const files = readdirSync(svc.dir).filter((f) => !outside.includes(f));
  // -wal и -shm — служебные файлы той же БД, пока она открыта (research R6).
  assert.deepEqual(files.filter((f) => !/^bank\.sqlite(-wal|-shm)?$/.test(f)), []);
});
