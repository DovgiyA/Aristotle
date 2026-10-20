// T013 — состав Группы через API: заведение, смена роли и подписи, отзыв, пределы Старших
// (ROLE-03, ROLE-04, ROLE-08, ROLE-21, ROLE-27, ROLE-35, ROLE-36, STATION-17; research R6 … R8;
// contracts/http-api.md).
// Журнал в проверках — записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUIDv7 } from "node:crypto";
import { startTestService, type TestService } from "../../../../tests/support/harness.ts";

function call(svc: TestService, as: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const headers: Record<string, string> = { ...svc.authHeaders(as) };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return svc.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

function journal(svc: TestService) {
  return svc.db
    .prepare("SELECT actorId, action, subjectType, subjectId, details FROM journal WHERE actorId IS NOT NULL ORDER BY seq")
    .all()
    .map((r) => ({ ...r, details: r["details"] === null ? null : JSON.parse(String(r["details"])) }));
}

test("POST /api/members: 201, запись Члена Группы и журнал member.create", async (t) => {
  const svc = await startTestService(t);
  const res = await call(svc, svc.seniorId, "POST", "/api/members", { label: "У1", role: "participant" });
  assert.equal(res.statusCode, 201);
  const member = res.json();
  assert.match(member.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.equal(member.label, "У1");
  assert.equal(member.role, "participant");
  assert.equal(member.state, "active");
  assert.equal(member.version, 1);
  assert.deepEqual(journal(svc), [
    { actorId: svc.seniorId, action: "member.create", subjectType: "member", subjectId: member.id, details: { role: "participant" } },
  ]);
});

test("POST /api/members: неизвестная роль и пустая подпись — 400", async (t) => {
  const svc = await startTestService(t);
  for (const payload of [{ label: "У1", role: "admin" }, { label: "", role: "participant" }]) {
    const res = await call(svc, svc.seniorId, "POST", "/api/members", payload);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "invalid_request");
  }
  assert.deepEqual(journal(svc), []);
});

test("GET /api/members и /api/members/{id}: состав со всеми, в том числе отозванными (ROLE-36)", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const n1 = svc.addMember("Н1", "observer");
  svc.db.prepare("UPDATE member SET state = 'revoked', version = version + 1 WHERE id = ?").run(u1);
  const list = await call(svc, n1, "GET", "/api/members");
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().items.map((m: { label: string; role: string; state: string }) => [m.label, m.role, m.state]),
    [["С1", "senior", "active"], ["У1", "participant", "revoked"], ["Н1", "observer", "active"]],
  );
  const one = await call(svc, n1, "GET", `/api/members/${u1}`);
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().state, "revoked");
  const missing = await call(svc, n1, "GET", `/api/members/${randomUUIDv7()}`);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, "not_found");
  assert.match(missing.json().message, /Член Группы/);
});

test("PATCH /api/members/{id}: роль и подпись, «было — стало» в журнале; без изменений — без журнала", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const res = await call(svc, svc.seniorId, "PATCH", `/api/members/${u1}`, { expectedVersion: 1, role: "observer", label: "У1′" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().version, 2);
  assert.equal(res.json().role, "observer");
  assert.deepEqual(journal(svc), [
    {
      actorId: svc.seniorId,
      action: "member.update",
      subjectType: "member",
      subjectId: u1,
      details: { role: { before: "participant", after: "observer" }, label: { before: "У1", after: "У1′" } },
    },
  ]);
  const same = await call(svc, svc.seniorId, "PATCH", `/api/members/${u1}`, { expectedVersion: 2, role: "observer" });
  assert.equal(same.statusCode, 200);
  assert.equal(same.json().version, 2);
  assert.equal(journal(svc).length, 1);
});

test("PATCH: без role и label — 400; устаревшая версия — 409 version_conflict с current", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const empty = await call(svc, svc.seniorId, "PATCH", `/api/members/${u1}`, { expectedVersion: 1 });
  assert.equal(empty.statusCode, 400);
  await call(svc, svc.seniorId, "PATCH", `/api/members/${u1}`, { expectedVersion: 1, label: "x" });
  const stale = await call(svc, svc.seniorId, "PATCH", `/api/members/${u1}`, { expectedVersion: 1, role: "observer" });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, "version_conflict");
  assert.equal(stale.json().current.version, 2);
  assert.equal(stale.json().current.label, "x");
  assert.equal(stale.json().current.role, "participant");
});

test("пределы Старших: третий — 409 senior_limit, последний — 409 last_senior (ROLE-04, ROLE-35)", async (t) => {
  const svc = await startTestService(t);
  const s2 = svc.addMember("С2", "senior");
  const u1 = svc.addMember("У1");
  const third = await call(svc, svc.seniorId, "POST", "/api/members", { label: "С3", role: "senior" });
  assert.equal(third.statusCode, 409);
  assert.equal(third.json().error, "senior_limit");
  const promote = await call(svc, svc.seniorId, "PATCH", `/api/members/${u1}`, { expectedVersion: 1, role: "senior" });
  assert.equal(promote.statusCode, 409);
  assert.equal(promote.json().error, "senior_limit");
  // Снять себя при двух Старших можно; последнего — нельзя.
  const self = await call(svc, svc.seniorId, "PATCH", `/api/members/${svc.seniorId}`, { expectedVersion: 1, role: "participant" });
  assert.equal(self.statusCode, 200);
  const last = await call(svc, s2, "PATCH", `/api/members/${s2}`, { expectedVersion: 1, role: "participant" });
  assert.equal(last.statusCode, 409);
  assert.equal(last.json().error, "last_senior");
  const revokeLast = await call(svc, s2, "POST", `/api/members/${s2}/revoke`, { expectedVersion: 1 });
  assert.equal(revokeLast.statusCode, 409);
  assert.equal(revokeLast.json().error, "last_senior");
});

test("POST /api/members/{id}/revoke: отзыв, журнал member.revoke; повтор и смена отозванного — 409 member_not_active", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const res = await call(svc, svc.seniorId, "POST", `/api/members/${u1}/revoke`, { expectedVersion: 1 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, "revoked");
  assert.equal(res.json().version, 2);
  assert.deepEqual(journal(svc), [{ actorId: svc.seniorId, action: "member.revoke", subjectType: "member", subjectId: u1, details: null }]);
  const again = await call(svc, svc.seniorId, "POST", `/api/members/${u1}/revoke`, { expectedVersion: 2 });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, "member_not_active");
  const patch = await call(svc, svc.seniorId, "PATCH", `/api/members/${u1}`, { expectedVersion: 2, role: "observer" });
  assert.equal(patch.statusCode, 409);
  assert.equal(patch.json().error, "member_not_active");
  const missing = await call(svc, svc.seniorId, "POST", `/api/members/${randomUUIDv7()}/revoke`, { expectedVersion: 1 });
  assert.equal(missing.statusCode, 404);
});

test("Участник и Наблюдатель не ведут состав — 403 forbidden, журнал пуст (ROLE-21)", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const n1 = svc.addMember("Н1", "observer");
  for (const as of [u1, n1]) {
    const requests = [
      call(svc, as, "POST", "/api/members", { label: "У3", role: "participant" }),
      call(svc, as, "PATCH", `/api/members/${u1}`, { expectedVersion: 1, role: "senior" }),
      call(svc, as, "POST", `/api/members/${n1}/revoke`, { expectedVersion: 1 }),
    ];
    for (const res of await Promise.all(requests)) {
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error, "forbidden");
    }
  }
  assert.deepEqual(journal(svc), []);
});

// T052, T053 фичи 002 — ревью кода 2026-10-17.
test("PATCH без role и label, но с неизвестным полем — 400 invalid_request, журнал пуст", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const res = await call(svc, svc.seniorId, "PATCH", `/api/members/${u1}`, { expectedVersion: 1, unexpected: true });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_request");
  assert.deepEqual(journal(svc), []);
});

test("состав — в порядке заведения, даже если часы перевели назад (ROLE-36)", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  // У2 заведён позже, но часы машины к тому времени перевели назад.
  svc.db.prepare("UPDATE member SET createdAt = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(u2);
  const items = (await call(svc, svc.seniorId, "GET", "/api/members")).json().items;
  assert.deepEqual(items.map((m: { id: string }) => m.id), [svc.seniorId, u1, u2]);
});
