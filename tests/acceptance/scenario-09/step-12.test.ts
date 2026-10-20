// T050 фичи 004 — сценарий 9, шаг 9.12: один из двух Ретрансляторов Группы недоступен — Станция
// работает через Проход на втором не дольше 30 секунд после запуска локальной части (STATION-05,
// SC-005). Ящик — фича 020.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startLocalServer } from "@aristotel/station";
import { TEST_STATION_PASSWORD, startNetwork, startStation, waitFor } from "../../support/network.ts";

test("9.12: R1 недоступен — вход через R2 не дольше 30 с", async (t) => {
  const net = await startNetwork(t, { relays: 2 });
  await waitFor(() => net.relays.every((r) => r.server!.passages.hasControl("A")));
  const station = await startStation(t, net);
  assert.equal(station.server.part.state().passage, net.relays[0]!.relay.url);
  await station.server.close();
  await net.relays[0]!.stop();
  const started = Date.now();
  // Тайм-аут попытки — 5 с, как в поставке (research R13).
  const local = await startLocalServer({ dataDir: station.dir });
  t.after(() => local.close());
  await local.part.unlock(TEST_STATION_PASSWORD);
  await waitFor(() => local.part.session !== undefined, 30_000, "вход через R2");
  const elapsed = Date.now() - started;
  t.diagnostic(`вход через второй Проход: ${elapsed} мс`);
  assert.ok(elapsed <= 30_000, String(elapsed));
  assert.equal(local.part.state().passage, net.relays[1]!.relay.url);
});
