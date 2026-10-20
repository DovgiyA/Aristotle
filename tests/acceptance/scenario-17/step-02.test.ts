// T028 — сценарий 17, шаг 17.2: У1 ставит Секрет на Запись, затем пытается снять метку —
// поставить можно, снять — нет (ROLE-17, ROLE-18). Автоматический Секрет (17.1) — фичи 005–007.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, groupA, startTestService } from "../../support/harness.ts";

test("17.2: У1 ставит Секрет — метка стоит, в журнале кто, что, когда; снять не может", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const created = (await callAs(svc, a.u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const before = Date.now();
  const marked = await callAs(svc, a.u1, "POST", `/api/records/${created.id}/secret/mark`, { expectedVersion: 1 });
  assert.equal(marked.statusCode, 200);
  assert.equal(marked.json().secret, true);
  const entry = (await callAs(svc, a.c1, "GET", `/api/journal?action=record.secret.mark`)).json().items[0];
  assert.equal(entry.actorId, a.u1);
  assert.equal(entry.subjectId, created.id);
  assert.ok(Date.parse(entry.at) >= before - 1000);

  const unmark = await callAs(svc, a.u1, "POST", `/api/records/${created.id}/secret/unmark`, { expectedVersion: 2 });
  assert.equal(unmark.statusCode, 403);
  assert.equal(unmark.json().error, "forbidden");
  assert.equal((await callAs(svc, a.u1, "GET", `/api/records/${created.id}`)).json().secret, true);
});
