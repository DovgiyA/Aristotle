// T067 фичи 004 — сценарий 10, шаг 10.6: У2 сдаёт S2, пока она на связи; С1 даёт команду — локальная
// часть удаляет Ключ станции и station.json, отчитывается Опорной станции и останавливается
// (STATION-20, STATION-22). Рабочие копии и офлайн-черновики — фича 009.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addMember } from "../../support/harness.ts";
import { callStation, startNetwork, startStation, waitFor } from "../../support/network.ts";

test("10.6: сдача S2 на связи — файлы удалены, локальная часть остановилась, журнал", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u2 = addMember(net.server.db, "У2");
  const s2 = await startStation(t, net, u2);
  const res = await callStation(net, net.seniorId, "POST", `/api/stations/${s2.result.stationId}/revoke`, { reason: "handover" });
  assert.equal(res.json().revokeReason, "handover");
  await waitFor(() => s2.server.part.deleted, 10_000, "команда удаления выполнена");
  assert.equal(existsSync(join(s2.dir, "station-key.age")), false);
  assert.equal(existsSync(join(s2.dir, "station.json")), false);
  await waitFor(
    () => fetch(`http://127.0.0.1:${s2.server.port}/local/state`).then(() => false, () => true),
    5000,
    "локальная часть остановилась",
  );
  const actions = net.server.db
    .prepare("SELECT action, actorId FROM journal WHERE subjectId = ? AND action IN ('station.revoke', 'station.deletion.confirm') ORDER BY seq")
    .all(s2.result.stationId)
    .map((r) => [r["action"], r["actorId"]]);
  assert.deepEqual(actions, [
    ["station.revoke", net.seniorId],
    ["station.deletion.confirm", null],
  ]);
});
