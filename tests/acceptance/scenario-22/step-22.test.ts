// T062 — шаг 22.22 (первые две фразы): новый вид Материала местно не завести — он приходит версией
// Словаря Сети только вместе с версией программы (BANK-63, DICT-60).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { applyTestDictionary, nextTestVersion, signWithTestCoordinator } from "../../support/dictionary.ts";

test("22.22: местного вида Материала нет; версия с видом, неизвестным программе, — unsupported", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const local = await callAs(svc, svc.seniorId, "POST", "/api/local-extension/proposals", { kind: "enum_value", payload: { enum: "material_kind", code: "x_kind", label: "x" } });
  assert.equal(local.json().error, "local_weakening");
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => b.programRequirements.materialKinds.push("x_kind")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).json().reason, "unsupported");
});
