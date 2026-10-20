// T027 фичи 001, T005 фичи 002 — POST /api/members/bootstrap: первый Старший заводится ровно один раз,
// в ответе — номер версии записи Члена Группы (ROLE-26, FR-003; contracts/http-api.md).
// Журнал в проверках — записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_VERSION_HEADER } from "@aristotel/protocol";
import { startTestService, type TestService } from "../../../../tests/support/harness.ts";

function bootstrap(svc: TestService, payload: unknown) {
  return svc.maintenance.inject({
    method: "POST",
    url: "/api/members/bootstrap",
    headers: { [API_VERSION_HEADER]: "1", authorization: `Bearer ${svc.token}`, "content-type": "application/json" },
    payload: payload as Record<string, unknown>,
  });
}

test("201: заведён Старший; журнал member.bootstrap с автором — им самим", async (t) => {
  const svc = await startTestService(t, { emptyGroup: true });
  const res = await bootstrap(svc, { label: "С1", osAccount: "u" });
  assert.equal(res.statusCode, 201);
  const member = res.json();
  assert.equal(member.label, "С1");
  assert.equal(member.role, "senior");
  assert.equal(member.state, "active");
  assert.equal(member.version, 1);
  assert.match(member.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.equal(typeof member.createdAt, "string");
  const journal = svc.db.prepare("SELECT actorId, action, subjectId, details FROM journal WHERE actorId IS NOT NULL").all();
  assert.deepEqual(
    journal.map((r) => ({ ...r, details: JSON.parse(String(r["details"])) })),
    [{ actorId: member.id, action: "member.bootstrap", subjectId: member.id, details: { via: "cli-init", osAccount: "u" } }],
  );
});

test("повтор — 409 already_bootstrapped, второго Старшего и записи журнала нет", async (t) => {
  const svc = await startTestService(t, { emptyGroup: true });
  assert.equal((await bootstrap(svc, { label: "С1", osAccount: "u" })).statusCode, 201);
  const again = await bootstrap(svc, { label: "С2", osAccount: "u" });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, "already_bootstrapped");
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM member").get()?.["n"], 1);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE actorId IS NOT NULL").get()?.["n"], 1);
});

test("два одновременных вызова — заведён ровно один (edge case)", async (t) => {
  const svc = await startTestService(t, { emptyGroup: true });
  const results = await Promise.all([
    bootstrap(svc, { label: "С1", osAccount: "u" }),
    bootstrap(svc, { label: "С2", osAccount: "u" }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM member").get()?.["n"], 1);
});

test("пустая подпись — 400 invalid_request", async (t) => {
  const svc = await startTestService(t, { emptyGroup: true });
  const res = await bootstrap(svc, { label: "", osAccount: "u" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_request");
});

test("в Группе уже есть Член Группы — 409 already_bootstrapped", async (t) => {
  const svc = await startTestService(t);
  const res = await bootstrap(svc, { label: "С2", osAccount: "u" });
  assert.equal(res.statusCode, 409);
});
