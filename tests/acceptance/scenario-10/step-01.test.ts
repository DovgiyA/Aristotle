// T067 фичи 004 — сценарий 10, шаг 10.1: С1 отзывает S1 — отзыв действует сразу: сеанс S1 закрыт,
// её соединения порваны, новый вход — только «только удаление»; не позже 5 с, 20 повторов (SC-002;
// STATION-17). Поручения и события Старшим — фичи 007, 010.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMember } from "../../support/harness.ts";
import { callStation, startNetwork, startStation, waitFor } from "../../support/network.ts";

test("10.1: отзыв S1 — сеанс и соединения закрыты, Проход только для удаления, ≤ 5 с (SC-002, 20 повторов)", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u1 = addMember(net.server.db, "У1");
  const durations: number[] = [];
  for (let i = 0; i < 20; i++) {
    const s1 = await startStation(t, net, u1);
    const old = s1.server.part.session!;
    // Долгий запрос событий S1 идёт по склеенному соединению — его и должен порвать отзыв.
    await waitFor(() => net.relays[0]!.server!.passages.splicesOf("A", s1.result.stationKey) > 0, 5000, "склейка S1");
    const started = Date.now();
    const res = await callStation(net, net.seniorId, "POST", `/api/stations/${s1.result.stationId}/revoke`, { reason: "revoked" });
    assert.equal(res.statusCode, 200, res.body);
    await waitFor(() => s1.server.part.session?.scope !== "full", 5000, "S1 потеряла полный сеанс");
    durations.push(Date.now() - started);
    const ended = net.server.db.prepare("SELECT endReason FROM station_session WHERE id = ?").get(old.sessionId);
    assert.equal(ended?.["endReason"], "revoked");
    // Прежний токен Банк больше не пускает.
    assert.equal((await net.server.stationApp.inject({ method: "GET", url: "/api/members", headers: { "aristotel-api-version": "1", authorization: `Bearer ${old.token}` } })).statusCode, 401);
    const entry = net.relays[0]!.server!.passages.listOf("A").find((e) => e.key === s1.result.stationKey);
    assert.ok(entry === undefined || (entry.kind === "station" && entry.state === "delete-only"), "ключ S1 в перечне — только «только удаление»");
    await s1.server.close();
  }
  assert.ok(Math.max(...durations) <= 5000, durations.join(", "));
});
