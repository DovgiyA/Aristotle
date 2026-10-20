// Пограничный случай фичи 004: Опорная станция остановлена развилкой Реестра (NET-12, фича 003) —
// Проходы по последней применённой версии продолжают работать: Станция в сеансе читает Банк, а
// перезапущенная локальная часть входит заново (STATION-05, STATION-10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSignedDocument } from "@aristotel/protocol";
import { readAccessToken, registryState } from "@aristotel/core";
import { startLocalServer } from "@aristotel/station";
import { registryDocument, signDocument } from "../../support/harness.ts";
import { TEST_STATION_PASSWORD, startNetwork, startStation, waitFor, type TestNetwork } from "../../support/network.ts";

async function apply(net: TestNetwork, issuedAt: string) {
  const doc = signDocument(registryDocument(net.server.db, { number: 2, relays: net.relays.map((r) => r.relay), coordinatorKeys: [net.coordinatorKey.publicKey], issuedAt }), net.coordinatorKey);
  return await net.server.app.inject({
    method: "POST",
    url: "/api/registry/versions",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${readAccessToken(net.dir)}`, "content-type": "application/json" },
    payload: serializeSignedDocument(doc),
  });
}

test("развилка остановила Опорную станцию — Станция работает через Проход и входит заново", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  assert.equal((await apply(net, "2026-10-19T10:00:00.000Z")).statusCode, 201);
  const conflict = await apply(net, "2026-10-19T10:00:01.000Z");
  assert.equal(conflict.json().error, "registry_conflict");
  assert.equal(registryState(net.server.db).halted, true);
  // Сеанс идёт дальше: чтение Банка через Проход.
  assert.equal((await station.local("GET", "/api/members")).status, 200);
  // Перезапуск локальной части — новый вход через тот же Проход.
  await station.server.close();
  const local = await startLocalServer({ dataDir: station.dir, attemptMs: 2000, retryMs: 100 });
  t.after(() => local.close());
  await local.part.unlock(TEST_STATION_PASSWORD);
  await waitFor(() => local.part.session !== undefined, 10_000, "вход при остановке развилкой");
  assert.equal((await local.part.request("GET", "/api/members")).status, 200);
});
