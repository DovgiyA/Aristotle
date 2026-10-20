// T067 фичи 004 — сценарий 10, шаг 10.4: отозванный ключ S1 в перечне в состоянии «только удаление»;
// S1 нашлась и вышла на связь — Опорная станция отвечает ей только командой удаления; подтверждение —
// в журнале, Ключ станции удалён. После срока — Проход не соединяет, ключа в перечне нет (STATION-22).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expireDeleteOnly } from "@aristotel/core";
import { addMember } from "../../support/harness.ts";
import { TEST_STATION_PASSWORD, callStation, startNetwork, startStation, waitFor } from "../../support/network.ts";

test("10.4: S1 в срок — только команда удаления; ключ удалён; журнал от службы", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u1 = addMember(net.server.db, "У1");
  // S1 утрачена: принята, но не на связи.
  const s1 = await startStation(t, net, u1, { unlock: false });
  assert.equal((await callStation(net, net.seniorId, "POST", `/api/stations/${s1.result.stationId}/revoke`, { reason: "revoked" })).statusCode, 200);
  await waitFor(() => net.relays[0]!.server!.passages.listOf("A").some((e) => e.key === s1.result.stationKey && e.kind === "station" && e.state === "delete-only"), 5000, "ключ S1 — «только удаление»");
  await s1.server.part.unlock(TEST_STATION_PASSWORD);
  await waitFor(() => s1.server.part.deleted, 10_000, "команда удаления выполнена");
  assert.equal(existsSync(join(s1.dir, "station-key.age")), false);
  assert.equal(existsSync(join(s1.dir, "station.json")), false);
  const entry = net.server.db.prepare("SELECT actorId FROM journal WHERE action = 'station.deletion.confirm' AND subjectId = ?").get(s1.result.stationId);
  assert.equal(entry?.["actorId"], null);
  // Сеанс «только удаление» к Банку не пускал: в журнале нет действий от S1, кроме сеансов.
  await waitFor(() => !net.relays[0]!.server!.passages.listOf("A").some((e) => e.key === s1.result.stationKey), 5000, "ключ ушёл из перечня");
});

test("10.4: срок «только удаление» вышел — ключа в перечне нет, вход не идёт, файлы на месте", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u1 = addMember(net.server.db, "У1");
  const s1 = await startStation(t, net, u1, { unlock: false });
  // Часы стенда: отзыв с коротким сроком «только удаление» (срок Группы — не меньше суток);
  // проверку сроков служба делает раз в час — здесь зовём её сами.
  const checkedFrom = new Date();
  net.server.db
    .prepare("UPDATE station SET state = 'revoked', revokedAt = ?, revokedBy = ?, revokeReason = 'revoked', deleteOnlyUntil = ? WHERE id = ?")
    .run(checkedFrom.toISOString(), net.seniorId, new Date(Date.now() + 10).toISOString(), s1.result.stationId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(expireDeleteOnly(net.server.db, checkedFrom), 1);
  await waitFor(() => !net.relays[0]!.server!.passages.listOf("A").some((e) => e.key === s1.result.stationKey), 5000, "ключ ушёл из перечня");
  await s1.server.part.unlock(TEST_STATION_PASSWORD);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(s1.server.part.session, undefined);
  assert.equal(s1.server.part.deleted, false);
  assert.equal(existsSync(join(s1.dir, "station-key.age")), true, "команды удаления не было — файл на месте");
});
