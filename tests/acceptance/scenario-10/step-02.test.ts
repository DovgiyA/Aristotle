// T045 — сценарий 10, шаг 10.2 в части «свои Материалы»: по утраченной Станции Старший получает
// перечень Материалов, заверенных ею, с состоянием доставки и Секретом (STATION-21). Рабочие копии и
// чужие копии в перечне — фичи 009, 022.
import { test } from "node:test";
import assert from "node:assert/strict";
import { materialNetwork, syntheticFile } from "../../support/materials.ts";
import { callStation, waitFor } from "../../support/network.ts";

test("10.2: Старший видит Материалы, заверенные отозванной Станцией S1; Участнику — 403", async (t) => {
  const { net, u1, s1, caseId, files } = await materialNetwork(t);
  const a = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "a.img", 100), case: caseId, kind: "image" });
  const b = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "b.img", 100), case: caseId, kind: "crypto_task" });
  assert.equal(a.status, 201, a.text);
  assert.equal(b.status, 201, b.text);
  await waitFor(() => s1.server.deliveries.list().every((i) => i.state === "done"), 30_000);
  await callStation(net, net.seniorId, "POST", `/api/stations/${s1.result.stationId}/revoke`, { reason: "revoked" });
  const list = await callStation(net, net.seniorId, "GET", `/api/stations/${s1.result.stationId}/materials`);
  assert.equal(list.statusCode, 200, list.body);
  const items = list.json().items as { id: string; secret: boolean; view: { delivery: string; attestations: { mark: string | null }[] } }[];
  assert.deepEqual(items.map((i) => i.id).sort(), [String(a.body["id"]), String(b.body["id"])].sort());
  assert.ok(items.every((i) => i.view.delivery === "delivered" && i.view.attestations[0]!.mark === "station_revoked"));
  assert.deepEqual(items.map((i) => i.secret).sort(), [false, true]);
  assert.equal((await callStation(net, u1, "GET", `/api/stations/${s1.result.stationId}/materials`)).statusCode, 403);
});
