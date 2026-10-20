// T067 фичи 004 — сценарий 10, шаг 10.9: С1 открывает вид «Станции» — видны состояния отозванных
// Станций: «только удаление» со сроком и «отозвана» (VIEW-47). Отметки Рабочих копий — фича 009.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StationView } from "@aristotel/protocol";
import { stationStateText } from "../../../packages/ui/src/views/stations.ts";
import { addMember } from "../../support/harness.ts";
import { callStation, startNetwork, startStation, uiLogin, waitFor } from "../../support/network.ts";

test("10.9: вид «Станции» в интерфейсе С1 — «действует», «только удаление» с оставшимся сроком, «отозвана»", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const c1 = await startStation(t, net);
  const u1 = addMember(net.server.db, "У1");
  const lost = await startStation(t, net, u1, { unlock: false });
  const handed = await startStation(t, net, u1);
  await callStation(net, net.seniorId, "POST", `/api/stations/${lost.result.stationId}/revoke`, { reason: "revoked" });
  await callStation(net, net.seniorId, "POST", `/api/stations/${handed.result.stationId}/revoke`, { reason: "handover" });
  await waitFor(() => handed.server.part.deleted, 10_000, "сдача завершена");
  const ui = await uiLogin(c1);
  const res = await ui.call("GET", "/api/stations");
  assert.equal(res.status, 200, res.text);
  const items = res.body["items"] as StationView[];
  const byId = (id: string) => items.find((s) => s.id === id)!;
  assert.equal(stationStateText(byId(c1.result.stationId)), "действует");
  const lostView = byId(lost.result.stationId);
  assert.equal(lostView.view, "delete-only");
  assert.equal(stationStateText(lostView), `только удаление: осталось 90 дн., до ${lostView.deleteOnlyUntil}`);
  const handedView = byId(handed.result.stationId);
  assert.deepEqual([handedView.view, handedView.revokeReason, stationStateText(handedView)], ["revoked", "handover", "отозвана"]);
  assert.notEqual(handedView.deletionConfirmedAt, null);
  // Участнику вида нет.
  assert.equal((await callStation(net, u1, "GET", "/api/stations")).statusCode, 403);
});
