// T029 — сценарий 17, шаг 17.3 без крипто-задачи (BANK-62 — фича 006) и без повторного ввода
// пароля (STATION-12 — фича 004): С1 снимает метку Секрет с Записи (ROLE-18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, groupA, startTestService } from "../../support/harness.ts";

test("17.3: С1 снимает метку Секрет — метки нет, в журнале кто, что, когда", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const created = (await callAs(svc, a.u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true })).json();
  const res = await callAs(svc, a.c1, "POST", `/api/records/${created.id}/secret/unmark`, { expectedVersion: 1 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().secret, false);
  const entry = (await callAs(svc, a.c1, "GET", `/api/journal?action=record.secret.unmark`)).json().items[0];
  assert.equal(entry.actorId, a.c1);
  assert.equal(entry.subjectId, created.id);
  // История показывает «было — стало» метки.
  const history = (await callAs(svc, a.u1, "GET", `/api/records/${created.id}/history`)).json().items;
  assert.deepEqual(
    history.filter((h: { field: string }) => h.field === "$secret").map((h: { before: unknown; after: unknown }) => [h.before, h.after]),
    [[null, true], [true, false]],
  );
});
