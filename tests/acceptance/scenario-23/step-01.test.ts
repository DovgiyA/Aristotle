// T046 фичи 003 — сценарий 23, шаг 23.1: Ключ Координатора С1 заменён версией, подписанной ключом
// С2; дальше подпись ключом С1 недействительна (NET-15, NET-09; spec.md US4, сценарии 1, 2, 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegistryBody } from "@aristotel/protocol";
import { callAs, groupA, insertCoordinatorKey, RELAY_X, RELAY_Y, signDocument, startTestService, testCoordinatorKey } from "../../support/harness.ts";

test("23.1: замена Ключа Координатора С1 версией, подписанной ключом С2", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const k1 = testCoordinatorKey(1);
  const k2 = testCoordinatorKey(2);
  insertCoordinatorKey(svc.db, a.c1, k1.publicKey);
  const draft = async (payload: unknown) => (await callAs(svc, a.c1, "POST", "/api/registry/draft", payload)).json();
  const apply = (doc: unknown) => callAs(svc, a.c1, "POST", "/api/registry/versions", doc);

  assert.equal((await apply(signDocument(await draft({ code: "A", addRelays: [RELAY_X] }), k1))).statusCode, 201);

  // С2 вносит свой ключ; черновик версии 2 — оба ключа и новый Ретранслятор; подписывает С1.
  insertCoordinatorKey(svc.db, a.c2 as string, k2.publicKey);
  const v2 = await draft({ addRelays: [RELAY_Y] });
  const body2 = parseRegistryBody(v2.body);
  assert.equal(body2.number, 2);
  assert.deepEqual(body2.coordinatorKeys, [k1.publicKey, k2.publicKey]);
  assert.deepEqual(body2.groups[0]?.relays, [RELAY_X, RELAY_Y]);
  assert.equal((await apply(signDocument(v2, k1))).statusCode, 201);

  // С1 снимает свой ключ; черновик версии 3 — только ключ С2; подписывает С2.
  assert.equal((await callAs(svc, a.c1, "POST", "/api/coordinator-keys/withdraw", {})).statusCode, 200);
  const v3 = await draft({});
  assert.deepEqual(parseRegistryBody(v3.body).coordinatorKeys, [k2.publicKey]);
  const applied = await apply(signDocument(v3, k2));
  assert.equal(applied.statusCode, 201, applied.body);
  assert.equal(applied.json().signedBy.key, k2.publicKey);

  // Версия 4, подписанная ключом С1, — отказ: в действующей версии 3 его нет.
  const v4 = await draft({});
  const refused = await apply(signDocument(v4, k1));
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().reason, "signature");
  assert.equal((await apply(signDocument(v4, k2))).statusCode, 201);
});
