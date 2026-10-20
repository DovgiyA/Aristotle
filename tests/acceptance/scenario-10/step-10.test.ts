// T067 фичи 004 — сценарий 10, шаг 10.10: утрачена Станция Старшего С2 с Ключом Координатора — ключ
// заменяют версией Реестра, подписанной Ключом Координатора С1; подпись ключом С2 после неё
// отклоняется; больше ничего на уровне Сети не нужно (STATION-24, NET-15).
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSignedDocument } from "@aristotel/protocol";
import { readAccessToken } from "@aristotel/core";
import { addMember, insertCoordinatorKey, registryDocument, signDocument, testCoordinatorKey, type TestCoordinatorKey } from "../../support/harness.ts";
import { callStation, startNetwork, startStation, waitFor, type TestNetwork } from "../../support/network.ts";

async function publishSigned(net: TestNetwork, keys: string[], signer: TestCoordinatorKey) {
  const doc = signDocument(registryDocument(net.server.db, { number: net.registryNumber() + 1, relays: net.relays.map((r) => r.relay), coordinatorKeys: keys }), signer);
  return await net.server.app.inject({
    method: "POST",
    url: "/api/registry/versions",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${readAccessToken(net.dir)}`, "content-type": "application/json" },
    payload: serializeSignedDocument(doc),
  });
}

test("10.10: Ключ Координатора С2 с утраченной Станции заменён версией С1; подпись С2 после неё — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const c2 = addMember(net.server.db, "С2", "senior");
  const k2 = testCoordinatorKey(0x52);
  insertCoordinatorKey(net.server.db, c2, k2.publicKey);
  assert.equal((await publishSigned(net, [net.coordinatorKey.publicKey, k2.publicKey], net.coordinatorKey)).statusCode, 201);
  const lost = await startStation(t, net, c2, { unlock: false });
  assert.equal((await callStation(net, net.seniorId, "POST", `/api/stations/${lost.result.stationId}/revoke`, { reason: "revoked" })).statusCode, 200);
  const replaced = await publishSigned(net, [net.coordinatorKey.publicKey], net.coordinatorKey);
  assert.equal(replaced.statusCode, 201, replaced.body);
  const number = net.registryNumber();
  const forged = await publishSigned(net, [k2.publicKey], k2);
  assert.equal(forged.statusCode, 422, forged.body);
  assert.equal(forged.json().error, "registry_rejected");
  assert.equal(net.registryNumber(), number);
});
