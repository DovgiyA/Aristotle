// T069 — шаг 22.20: в версии n+1 сменилась Подпись типа — Записи не тронуты, в подписях — новая
// (DICT-09, DICT-10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, createTestCase, createTestObject, nextTestVersion, postIndicator, signWithTestCoordinator } from "../../support/dictionary.ts";

test("22.20: смена Подписи типа не трогает Записи", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const ind = (await postIndicator(svc, u1, op.id, "callsign", { value: "x" })).json();
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => (b.elements.find((e) => e.id === T.indicator("callsign"))!.label = "Позывной оператора")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const after = (await callAs(svc, u1, "GET", `/api/records/${ind.id}`)).json();
  assert.deepEqual([after.version, after.fields["type"], after.updatedAt], [1, ind.fields["type"], ind.updatedAt]);
  assert.match(after.view.label, /^Позывной оператора: x/);
});
