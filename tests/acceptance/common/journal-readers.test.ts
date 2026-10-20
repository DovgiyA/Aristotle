// T039 — журнал и состав Группы читают все Члены Группы; Наблюдатель — без записей о Секрет-Записях
// при любых фильтрах (ROLE-22, ROLE-36, ROLE-07, VIEW-16, FR-010, FR-011; SC-002).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, groupA, startTestService } from "../../support/harness.ts";

test("журнал: У1 видит всё, Н1 — всё, кроме записей о Секрет-Записи, с фильтрами и без", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const plain = (await callAs(svc, a.c1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  await callAs(svc, a.u1, "PATCH", `/api/records/${plain.id}`, { expectedVersion: 1, fields: { x: "w" } });
  const secret = (await callAs(svc, a.u1, "POST", "/api/records", { type: "test.note", fields: { x: "y" } })).json();
  await callAs(svc, a.u1, "POST", `/api/records/${secret.id}/secret/mark`, { expectedVersion: 1 });
  await callAs(svc, a.u1, "PATCH", `/api/records/${secret.id}`, { expectedVersion: 2, fields: { x: "z" } });
  await callAs(svc, a.c1, "POST", "/api/members", { label: "У3", role: "participant" });

  // Записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
  type Entry = { actorId: string | null; action: string };
  const byMembers = (items: Entry[]): Entry[] => items.filter((j) => j.actorId !== null);
  const all = byMembers((await callAs(svc, a.u1, "GET", "/api/journal")).json().items);
  assert.deepEqual(all.map((j: { action: string }) => j.action), [
    "record.create",
    "record.update",
    "record.create",
    "record.secret.mark",
    "record.update",
    "member.create",
  ]);

  const queries = ["", `?member=${a.u1}`, `?record=${secret.id}`, `?record=${plain.id}`, "?action=record.update", "?action=record.secret.mark", "?limit=1"];
  for (const query of queries) {
    const res = await callAs(svc, a.n1, "GET", `/api/journal${query}`);
    assert.equal(res.statusCode, 200, query);
    // SC-002: ни одного Идентификатора Секрет-Записи в ответе Наблюдателю.
    assert.ok(!res.body.includes(secret.id), `${query}: в ответе Н1 есть Секрет-Запись`);
  }
  const observed = byMembers((await callAs(svc, a.n1, "GET", "/api/journal")).json().items);
  assert.deepEqual(observed.map((j: { action: string }) => j.action), ["record.create", "record.update", "member.create"]);
});

test("состав Группы читают У1 и Н1 — действующих и отозванных, с подписью, ролью и состоянием", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  await callAs(svc, a.c1, "POST", `/api/members/${a.u2}/revoke`, { expectedVersion: 1 });
  for (const reader of [a.u1, a.n1]) {
    const items = (await callAs(svc, reader, "GET", "/api/members")).json().items;
    assert.deepEqual(
      items.map((m: { label: string; role: string; state: string }) => [m.label, m.role, m.state]),
      [
        ["С1", "senior", "active"],
        ["У1", "participant", "active"],
        ["У2", "participant", "revoked"],
        ["Н1", "observer", "active"],
        ["С2", "senior", "active"],
      ],
    );
  }
});
