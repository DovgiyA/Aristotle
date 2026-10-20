// T037 фичи 003 — сценарий 19, шаг 19.14: Коды не по NET-51 — отказ и в черновике, и в применении
// подписанной версии; Коды A и K2 — приняты (NET-51, NET-06; spec.md US3, сценарий 8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, insertCoordinatorKey, registryDocument, RELAY_X, signDocument, startTestService, testCoordinatorKey } from "../../support/harness.ts";

const k1 = testCoordinatorKey(1);

for (const code of ["a1", "А", "1A", "ABCDEFGHI"]) {
  test(`19.14: Код «${code}» — отказ`, async (t) => {
    const svc = await startTestService(t);
    insertCoordinatorKey(svc.db, svc.seniorId, k1.publicKey);
    const draft = await callAs(svc, svc.seniorId, "POST", "/api/registry/draft", { code, addRelays: [RELAY_X] });
    assert.equal(draft.statusCode, 422);
    assert.equal(draft.json().reason, "code_format");
    const signed = signDocument(registryDocument(svc.db, { code, coordinatorKeys: [k1.publicKey] }), k1);
    const res = await callAs(svc, svc.seniorId, "POST", "/api/registry/versions", signed);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().reason, "code_format");
    assert.match(res.json().message, /от 1 до 8 знаков/);
  });
}

for (const code of ["A", "K2"]) {
  test(`19.14: Код «${code}» — принят`, async (t) => {
    const svc = await startTestService(t);
    insertCoordinatorKey(svc.db, svc.seniorId, k1.publicKey);
    const draft = await callAs(svc, svc.seniorId, "POST", "/api/registry/draft", { code, addRelays: [RELAY_X] });
    assert.equal(draft.statusCode, 200, draft.body);
    const res = await callAs(svc, svc.seniorId, "POST", "/api/registry/versions", signDocument(draft.json(), k1));
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().body.groups[0].code, code);
  });
}
