// T016 — сценарий 11, шаг 11.7: Старший есть и сам назначает второго — без Координирующей Группы
// (ROLE-27, ROLE-21); третьего Старшего быть не может (ROLE-04).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, countRows, groupA, startTestService } from "../../support/harness.ts";

test("11.7: единственный Старший С1 назначает У2 Старшим; третьего — отказ", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId, { withoutSecondSenior: true });

  const promoted = await callAs(svc, a.c1, "PATCH", `/api/members/${a.u2}`, { expectedVersion: 1, role: "senior" });
  assert.equal(promoted.statusCode, 200);
  assert.equal(promoted.json().role, "senior");
  const entry = (await callAs(svc, a.c1, "GET", `/api/journal?action=member.update`)).json().items[0];
  assert.deepEqual(entry.details, { role: { before: "participant", after: "senior" } });
  assert.equal(entry.actorId, a.c1);

  // Третий Старший — ни назначением, ни заведением; состав не меняется (ROLE-04).
  const journalBefore = countRows(svc.db, "journal");
  const third = await callAs(svc, a.c1, "PATCH", `/api/members/${a.u1}`, { expectedVersion: 1, role: "senior" });
  assert.equal(third.json().error, "senior_limit");
  const newSenior = await callAs(svc, a.u2, "POST", "/api/members", { label: "С3", role: "senior" });
  assert.equal(newSenior.json().error, "senior_limit");
  assert.equal(countRows(svc.db, "journal"), journalBefore);
  const members = (await callAs(svc, a.n1, "GET", "/api/members")).json().items;
  assert.equal(members.filter((m: { role: string }) => m.role === "senior").length, 2);
});

test("11.7: Участник Старшего назначить не может", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId, { withoutSecondSenior: true });
  const res = await callAs(svc, a.u1, "PATCH", `/api/members/${a.u2}`, { expectedVersion: 1, role: "senior" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "forbidden");
});
