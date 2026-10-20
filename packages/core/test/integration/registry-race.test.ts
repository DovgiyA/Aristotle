// T051 фичи 003 — SC-005: служба отдельным процессом; 100 пар одновременных передач двух разных верно
// подписанных версий следующего номера — применена ровно одна, вторая — registry_conflict; следующая
// версия снимает остановку (NET-12, NET-52; research R14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY_FORMAT, coordinatorKeyProofMessage, type GroupKeyInfo } from "@aristotel/protocol";
import { readInstall } from "@aristotel/core";
import { apiRequest, prepareDataDir, RELAY_X, RELAY_Y, signDocument, spawnService, testCoordinatorKey } from "../../../../tests/support/harness.ts";

test("SC-005: 100 пар одновременных разных версий одного номера", { timeout: 300_000 }, async (t) => {
  const data = await prepareDataDir(t);
  const service = await spawnService(t, data);
  const k1 = testCoordinatorKey(1);
  const proof = Buffer.from(k1.sign(coordinatorKeyProofMessage(readInstall(data.dir).installId, data.seniorId))).toString("base64").replace(/=+$/, "");
  assert.equal((await apiRequest(data, "POST", "/api/coordinator-keys", { publicKey: k1.publicKey, proof })).status, 201);
  const key = (await apiRequest(data, "GET", "/api/group-key")).body as GroupKeyInfo;
  const version = (number: number, relay = RELAY_X) =>
    signDocument(
      {
        format: REGISTRY_FORMAT,
        signatures: [],
        body: JSON.stringify({
          number,
          issuedAt: "2026-10-17T10:00:00.000Z",
          coordinatingGroup: "A",
          coordinatorKeys: [k1.publicKey],
          groups: [{ code: "A", signingKey: key.signingKey, encryptionKey: key.encryptionKey, state: "active", relays: [relay] }],
        }),
      },
      k1,
    );
  assert.equal((await apiRequest(data, "POST", "/api/registry/versions", version(1))).status, 201);

  let number = 1;
  for (let pair = 0; pair < 100; pair++) {
    const next = number + 1;
    const results = await Promise.all([
      apiRequest(data, "POST", "/api/registry/versions", version(next, RELAY_X)),
      apiRequest(data, "POST", "/api/registry/versions", version(next, RELAY_Y)),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409], `пара ${pair}`);
    const loser = results.find((r) => r.status === 409)!.body as { error: string };
    assert.equal(loser.error, "registry_conflict", `пара ${pair}`);
    const state = (await apiRequest(data, "GET", "/api/registry")).body as { current: { number: number }; halted: boolean };
    assert.equal(state.current.number, next);
    assert.equal(state.halted, true);
    // NET-52: следующая версия снимает остановку.
    assert.equal((await apiRequest(data, "POST", "/api/registry/versions", version(next + 1))).status, 201, `пара ${pair}: снятие`);
    number = next + 1;
  }
  const final = (await apiRequest(data, "GET", "/api/registry")).body as { current: { number: number }; halted: boolean; conflicts: unknown[] };
  assert.equal(final.current.number, 201);
  assert.equal(final.halted, false);
  assert.equal(final.conflicts.length, 100);
  await service.stop();
});
