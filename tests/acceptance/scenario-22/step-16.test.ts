// T048 — шаг 22.16: тип объявлен устаревшим — новых значений по нему нельзя, старые читаются (DICT-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, createTestCase, createTestObject, nextTestVersion, postIndicator, signWithTestCoordinator } from "../../support/dictionary.ts";

test("22.16: устаревший тип — новое значение model_invalid, прежнее читается", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const old = (await postIndicator(svc, u1, op.id, "callsign", { value: "x" })).json();
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => (b.elements.find((e) => e.id === T.indicator("callsign"))!.state = "deprecated")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const fresh = await postIndicator(svc, u1, op.id, "callsign", { value: "y" });
  assert.deepEqual([fresh.statusCode, fresh.json().error], [400, "model_invalid"]);
  const read = await callAs(svc, u1, "GET", `/api/records/${old.id}`);
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().fields["value"], "x");
});
