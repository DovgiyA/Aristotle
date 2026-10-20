// T030 — сценарий 17, шаг 17.15: С1 снимает метку Секрет с Записи, которую Н1 не видел, — Н1 видит
// Запись со всей историей и записями журнала, в том числе за время Секрета (VIEW-58, ROLE-18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, groupA, startTestService } from "../../support/harness.ts";

test("17.15: после снятия метки Н1 видит Запись, всю историю и журнал о ней", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const created = (await callAs(svc, a.u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true })).json();
  // Изменение за время Секрета.
  await callAs(svc, a.u1, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } });
  assert.equal((await callAs(svc, a.n1, "GET", `/api/records/${created.id}`)).statusCode, 404);
  assert.deepEqual((await callAs(svc, a.n1, "GET", `/api/journal?record=${created.id}`)).json().items, []);

  await callAs(svc, a.c1, "POST", `/api/records/${created.id}/secret/unmark`, { expectedVersion: 2 });

  const record = await callAs(svc, a.n1, "GET", `/api/records/${created.id}`);
  assert.equal(record.statusCode, 200);
  assert.deepEqual(record.json().fields, { x: "w" });
  const history = (await callAs(svc, a.n1, "GET", `/api/records/${created.id}/history`)).json().items;
  assert.deepEqual(
    history.map((h: { version: number; field: string }) => [h.version, h.field]),
    [[1, "x"], [1, "$secret"], [2, "x"], [3, "$secret"]],
  );
  const journal = (await callAs(svc, a.n1, "GET", `/api/journal?record=${created.id}`)).json().items;
  assert.deepEqual(journal.map((j: { action: string }) => j.action), ["record.create", "record.update", "record.secret.unmark"]);
});
