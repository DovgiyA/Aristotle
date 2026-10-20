// Ревью, P2 — «было» равно «стало» по структуре JSON, а не по тексту: перестановка ключей
// объекта не меняет Запись, не пишет историю и журнал (BANK-07, edge case spec.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { registerRecordType, unregisterRecordType } from "../../src/bank/record-types.ts";
import { createRecord, updateRecord } from "../../src/bank/records.ts";
import { startTestService } from "../../../../tests/support/harness.ts";

test("перестановка ключей вложенного объекта — не изменение", async (t) => {
  registerRecordType({
    name: "test.obj",
    fields: Type.Object({ o: Type.Optional(Type.Unknown()) }, { additionalProperties: false }),
    indexText: () => "",
  });
  t.after(() => unregisterRecordType("test.obj"));
  const svc = await startTestService(t);
  const n = (table: string) => Number(svc.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
  const record = createRecord(svc.db, { type: "test.obj", fields: { o: { a: 1, b: { c: [1, { d: 2, e: 3 }] } } } }, svc.seniorId);
  const before = [n("record_history"), n("journal")];

  const same = updateRecord(svc.db, record.id, { expectedVersion: 1, fields: { o: { b: { c: [1, { e: 3, d: 2 }] }, a: 1 } } }, svc.seniorId);
  assert.equal(same.version, 1);
  assert.deepEqual([n("record_history"), n("journal")], before);

  // Порядок элементов массива — значимый: это изменение.
  const changed = updateRecord(svc.db, record.id, { expectedVersion: 1, fields: { o: { a: 1, b: { c: [{ d: 2, e: 3 }, 1] } } } }, svc.seniorId);
  assert.equal(changed.version, 2);
});
