// T026 — шаг 22.15: версия с неверной подписью или подписанная ключом не из Реестра не применяется
// (DICT-17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callMaintenance, launchTestNetwork, startTestService, testCoordinatorKey } from "../../support/harness.ts";
import { TEST_COORDINATOR_SEED, signWithTestCoordinator, testDictionaryDocument } from "../../support/dictionary.ts";

test("22.15: чужой ключ и испорченная подпись — отказ signature; Словарь не применён", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc, undefined, TEST_COORDINATOR_SEED);
  const foreign = signWithTestCoordinator(testDictionaryDocument(), testCoordinatorKey(0x55));
  const r1 = await callMaintenance(svc, "POST", "/api/dictionary/versions", foreign);
  assert.deepEqual([r1.statusCode, r1.json().error, r1.json().reason], [422, "dictionary_rejected", "signature"]);
  const signed = signWithTestCoordinator(testDictionaryDocument());
  const broken = { ...signed, body: signed.body.replace('"issuedAt":"2026', '"issuedAt":"2027') };
  const r2 = await callMaintenance(svc, "POST", "/api/dictionary/versions", broken);
  assert.equal(r2.json().reason, "signature");
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM dictionary_version").get()?.["n"], 0);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM dict_element").get()?.["n"], 0);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'dictionary.reject'").get()?.["n"], 2);
});
