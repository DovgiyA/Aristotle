// T064 — контракт маршрутов Местного расширения (contracts/http-api.md фичи 005; конституция III;
// DICT-05, DICT-07): схемы payload пяти видов, ответы, 422 local_weakening, 409 proposal_not_open, права.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../../../tests/support/harness.ts";
import { T, applyTestDictionary } from "../../../../tests/support/dictionary.ts";

test("предложение: схема ответа; лишнее поле payload — 400; неизвестный вид — 400", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const ok = await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "enum_value", payload: { enum: "os_distro", code: "x", label: "x" } });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(Object.keys(ok.json()).sort(), ["decidedAt", "decidedBy", "id", "kind", "payload", "proposedAt", "proposedBy", "reason", "resultId", "state"]);
  assert.equal((await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "enum_value", payload: { enum: "os_distro", code: "y", label: "y", extra: 1 } })).statusCode, 400);
  assert.equal((await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "x", payload: {} })).statusCode, 400);
  for (const kind of ["type", "enum_value", "template_field", "stop_list_entry", "override"]) {
    assert.equal((await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind, payload: { x: 1 } })).statusCode, 400, kind);
  }
});

test("права: Наблюдатель не предлагает, Участник не решает; 409 proposal_not_open; 422 local_weakening", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  assert.equal((await callAs(svc, h1, "POST", "/api/local-extension/proposals", { kind: "enum_value", payload: { enum: "os_distro", code: "x", label: "x" } })).statusCode, 403);
  const p = (await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "enum_value", payload: { enum: "os_distro", code: "x", label: "x" } })).json();
  assert.equal((await callAs(svc, u1, "POST", `/api/local-extension/proposals/${p.id}/reject`, { reason: "x" })).statusCode, 403);
  assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.id}/reject`, { reason: "x" })).statusCode, 200);
  assert.deepEqual([(await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.id}/accept`, {})).statusCode], [409]);
  const weak = await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "override", payload: { element: T.indicator("ip"), property: "comparable", value: false } });
  assert.deepEqual([weak.statusCode, weak.json().error], [422, "local_weakening"]);
  assert.equal((await callAs(svc, h1, "GET", "/api/local-extension")).statusCode, 200);
  assert.equal((await callAs(svc, h1, "GET", "/api/local-extension/proposals?state=rejected")).json().items.length, 1);
});
