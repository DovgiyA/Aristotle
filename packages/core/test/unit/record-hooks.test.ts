// T010 — ловушки типа Записи: prepare (проверка и значения по умолчанию), derive (производное в
// той же транзакции), caseOf (колонка журнала caseId) — research R2, R12 фичи 005; BANK-05.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { startTestService } from "../../../../tests/support/harness.ts";
import { createRecord, getRecord, updateRecord } from "../../src/bank/records.ts";
import { registerRecordType, unregisterRecordType } from "../../src/bank/record-types.ts";
import { ApiError } from "../../src/api/errors.ts";

const TYPE = "test.hooked";

function register(t: { after: (fn: () => void) => void }): void {
  registerRecordType({
    name: TYPE,
    fields: Type.Object({ x: Type.String(), stamp: Type.String(), caseRef: Type.Optional(Type.String()) }, { additionalProperties: false }),
    indexText: (f) => String(f["x"]),
    prepare: (ctx, fields) => {
      if (fields["x"] === "bad") throw new ApiError("model_invalid", {}, { issues: [{ field: "x", rule: "value", code: "x_bad" }] });
      if (fields["x"] === "boom-derive") return { fields: { ...fields, stamp: "d" } };
      return { fields: { ...fields, stamp: `${ctx.authorId}:${fields["x"]}` }, secret: fields["x"] === "secret" };
    },
    derive: (ctx, record) => {
      if (record.fields["stamp"] === "d") throw new Error("сбой производного");
      ctx.db.prepare("INSERT OR REPLACE INTO record_case (recordId, caseId) VALUES (?, ?)").run(record.id, String(record.fields["caseRef"] ?? "none"));
    },
    caseOf: (_ctx, record) => (record.fields["caseRef"] === undefined ? null : String(record.fields["caseRef"])),
  });
  t.after(() => unregisterRecordType(TYPE));
}

const counts = (db: import("../../src/db/open.ts").Db) => ({
  record: Number(db.prepare("SELECT count(*) AS n FROM record WHERE type = ?").get(TYPE)?.["n"]),
  history: Number(db.prepare("SELECT count(*) AS n FROM record_history").get()?.["n"]),
  journal: Number(db.prepare("SELECT count(*) AS n FROM journal").get()?.["n"]),
  derived: Number(db.prepare("SELECT count(*) AS n FROM record_case").get()?.["n"]),
});

test("prepare дополняет поля и может поставить метку Секрет при создании", async (t) => {
  const svc = await startTestService(t);
  register(t);
  const plain = createRecord(svc.db, { type: TYPE, fields: { x: "v" } }, svc.seniorId);
  assert.equal(plain.fields["stamp"], `${svc.seniorId}:v`);
  assert.equal(plain.secret, false);
  const secret = createRecord(svc.db, { type: TYPE, fields: { x: "secret" } }, svc.seniorId);
  assert.equal(secret.secret, true);
});

test("отказ prepare — model_invalid; нет ни Записи, ни истории, ни журнала", async (t) => {
  const svc = await startTestService(t);
  register(t);
  const before = counts(svc.db);
  assert.throws(
    () => createRecord(svc.db, { type: TYPE, fields: { x: "bad" } }, svc.seniorId),
    (e: unknown) => e instanceof ApiError && e.code === "model_invalid" && JSON.stringify(e.extra).includes("x_bad"),
  );
  assert.deepEqual(counts(svc.db), before);
});

test("сбой derive откатывает Запись, историю, журнал и производное", async (t) => {
  const svc = await startTestService(t);
  register(t);
  const before = counts(svc.db);
  assert.throws(() => createRecord(svc.db, { type: TYPE, fields: { x: "boom-derive" } }, svc.seniorId), /сбой производного/);
  assert.deepEqual(counts(svc.db), before);
  assert.equal(svc.db.isTransaction, false);
});

test("derive пишет производное, caseOf — колонку журнала caseId; правка тоже идёт через ловушки", async (t) => {
  const svc = await startTestService(t);
  register(t);
  const r = createRecord(svc.db, { type: TYPE, fields: { x: "v", caseRef: "c1" } }, svc.seniorId);
  assert.equal(svc.db.prepare("SELECT caseId FROM record_case WHERE recordId = ?").get(r.id)?.["caseId"], "c1");
  const caseIds = () =>
    svc.db.prepare("SELECT caseId FROM journal WHERE subjectId = ? ORDER BY seq").all(r.id).map((row) => row["caseId"]);
  assert.deepEqual(caseIds(), ["c1"]);
  const u = updateRecord(svc.db, r.id, { expectedVersion: 1, fields: { x: "w" } }, svc.seniorId);
  assert.equal(u.fields["stamp"], `${svc.seniorId}:w`);
  assert.deepEqual(caseIds(), ["c1", "c1"]);
  // История — по всем изменённым полям, включая выставленные prepare.
  const fields = svc.db.prepare("SELECT field FROM record_history WHERE recordId = ? AND version = 2 ORDER BY field").all(r.id).map((row) => row["field"]);
  assert.deepEqual(fields, ["stamp", "x"]);
  assert.equal(getRecord(svc.db, r.id)?.version, 2);
});

test("тип без ловушек (test.note) работает как в фиче 001, caseId в журнале — NULL", async (t) => {
  const svc = await startTestService(t);
  const r = createRecord(svc.db, { type: "test.note", fields: { x: "v" } }, svc.seniorId);
  assert.equal(svc.db.prepare("SELECT caseId FROM journal WHERE subjectId = ?").get(r.id)?.["caseId"], null);
});
