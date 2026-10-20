// T017 — сценарий 11, шаг 11.9: единственный Старший не может снять с себя роль или отозвать себя —
// Группа не остаётся без Старшего (ROLE-35).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, countRows, groupA, startTestService } from "../../support/harness.ts";

test("11.9: единственный Старший С1 снимает с себя роль и отзывает себя — отказ обоим", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId, { withoutSecondSenior: true });
  const journalBefore = countRows(svc.db, "journal");
  const demote = await callAs(svc, a.c1, "PATCH", `/api/members/${a.c1}`, { expectedVersion: 1, role: "participant" });
  assert.equal(demote.statusCode, 409);
  assert.equal(demote.json().error, "last_senior");
  assert.match(demote.json().message, /без Старшего/);
  const revoke = await callAs(svc, a.c1, "POST", `/api/members/${a.c1}/revoke`, { expectedVersion: 1 });
  assert.equal(revoke.statusCode, 409);
  assert.equal(revoke.json().error, "last_senior");
  const me = (await callAs(svc, a.c1, "GET", `/api/members/${a.c1}`)).json();
  assert.deepEqual([me.role, me.state, me.version], ["senior", "active", 1]);
  assert.equal(countRows(svc.db, "journal"), journalBefore);
});

test("11.9: при двух Старших С1 снимает роль с себя или с С2 — принято", async (t) => {
  for (const target of ["self", "other"] as const) {
    const svc = await startTestService(t);
    const a = groupA(svc.db, svc.seniorId);
    const id = target === "self" ? a.c1 : a.c2!;
    const res = await callAs(svc, a.c1, "PATCH", `/api/members/${id}`, { expectedVersion: 1, role: "participant" });
    assert.equal(res.statusCode, 200, target);
    const seniors = (await callAs(svc, a.n1, "GET", "/api/members")).json().items.filter(
      (m: { role: string; state: string }) => m.role === "senior" && m.state === "active",
    );
    assert.equal(seniors.length, 1, target);
  }
});
