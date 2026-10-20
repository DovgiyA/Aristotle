// T014 фичи 001, T004 фичи 002, T022 фичи 004 — удостоверение на API Станций (сеанс тестовой Станции
// вместо токена локального доступа и заголовка автора), автор действия и право на действие
// (STATION-10, STATION-17, ROLE-09, FR-005; research R1 и R6 фичи 002, R9 фичи 004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestSession, startTestService } from "../../../../tests/support/harness.ts";

async function withPing(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  svc.app.get("/api/test/ping", { config: { right: "journal.read" } }, async () => ({ ok: true }));
  svc.app.get("/api/test/senior-only", { config: { right: "member.create" } }, async () => ({ ok: true }));
  return svc;
}

test("без сеанса, с неизвестным или истёкшим токеном — 401 session_required", async (t) => {
  const svc = await withPing(t);
  const expired = openTestSession(svc.db, svc.seniorId, { ttlMs: -1000 });
  for (const token of [undefined, "x", svc.token, expired.token]) {
    const headers: Record<string, string> = { ...svc.authHeaders(svc.seniorId) };
    if (token === undefined) delete headers["authorization"];
    else headers["authorization"] = `Bearer ${token}`;
    const res = await svc.app.inject({ method: "GET", url: "/api/test/ping", headers });
    assert.equal(res.statusCode, 401, String(token));
    assert.equal(res.json().error, "session_required");
    assert.match(res.json().message, /сеанс/);
  }
});

test("заголовок Aristotel-Member на API Станций — 400: автор — Член Группы Станции сеанса", async (t) => {
  const svc = await withPing(t);
  const u1 = svc.addMember("У1", "participant");
  const res = await svc.app.inject({
    method: "GET",
    url: "/api/test/ping",
    headers: { ...svc.authHeaders(svc.seniorId), "aristotel-member": u1 },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_request");
});

test("с токеном и Членом Группы запрос исполняется", async (t) => {
  const svc = await withPing(t);
  const res = await svc.app.inject({
    method: "GET",
    url: "/api/test/ping",
    headers: svc.authHeaders(svc.seniorId),
  });
  assert.equal(res.statusCode, 200);
});

test("автор — отозванный Член Группы — 403 member_revoked (STATION-17)", async (t) => {
  const svc = await withPing(t);
  const u1 = svc.addMember("У1", "participant");
  svc.db.prepare("UPDATE member SET state = 'revoked', version = version + 1 WHERE id = ?").run(u1);
  const res = await svc.app.inject({ method: "GET", url: "/api/test/ping", headers: svc.authHeaders(u1) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "member_revoked");
  assert.match(res.json().message, /отозван/);
});

test("роли действие не разрешено — 403 forbidden по-русски", async (t) => {
  const svc = await withPing(t);
  const u1 = svc.addMember("У1", "participant");
  const res = await svc.app.inject({ method: "GET", url: "/api/test/senior-only", headers: svc.authHeaders(u1) });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(Object.keys(res.json()).sort(), ["error", "message"]);
  assert.equal(res.json().error, "forbidden");
  assert.match(res.json().message, /роли/);
  const senior = await svc.app.inject({ method: "GET", url: "/api/test/senior-only", headers: svc.authHeaders(svc.seniorId) });
  assert.equal(senior.statusCode, 200);
});

test("отказ по праву — раньше проверки тела: Наблюдатель с неверным телом получает 403, а не 400", async (t) => {
  const svc = await withPing(t);
  const n1 = svc.addMember("Н1", "observer");
  const res = await svc.app.inject({
    method: "POST",
    url: "/api/records",
    headers: { ...svc.authHeaders(n1), "content-type": "application/json" },
    payload: "{не json",
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "forbidden");
});
