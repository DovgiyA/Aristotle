// Команда удаления на стороне Станции (STATION-22, contracts/stanciya-v1.md «Команда удаления»):
// ответ на подтверждение потерян, а Ретранслятор уже убрал ключ из перечня, — локальная часть всё
// равно завершает удаление: Опорная станция его записала.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { broadcastPassageList } from "@aristotel/core";
import { addMember } from "../../../../tests/support/harness.ts";
import { callStation, startNetwork, startStation, waitFor } from "../../../../tests/support/network.ts";

test("ответ на подтверждение удаления потерян, ключа в перечне нет — файлы всё равно удалены", async (t) => {
  let lose = true;
  const net = await startNetwork(t, {
    relays: 1,
    extend: (_app, _db, stationApp) => {
      stationApp.addHook("onSend", async (request, reply, payload) => {
        if (lose && request.url === "/api/station/deletion/confirm" && reply.statusCode === 200) {
          lose = false;
          // Удаление записано, ответ не уходит; перечень без ключа — сразу.
          request.raw.socket.destroy();
          broadcastPassageList();
        }
        return payload;
      });
    },
  });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u1 = addMember(net.server.db, "У1");
  const s1 = await startStation(t, net, u1);
  assert.equal((await callStation(net, net.seniorId, "POST", `/api/stations/${s1.result.stationId}/revoke`, { reason: "handover" })).statusCode, 200);
  await waitFor(() => net.server.db.prepare("SELECT deletionConfirmedAt FROM station WHERE id = ?").get(s1.result.stationId)?.["deletionConfirmedAt"] !== null, 10_000, "удаление записано");
  assert.equal(lose, false, "ответ действительно потерян");
  await waitFor(() => s1.server.part.deleted, 10_000, "локальная часть завершила удаление");
  assert.equal(existsSync(join(s1.dir, "station-key.age")), false);
  assert.equal(existsSync(join(s1.dir, "station.json")), false);
});
