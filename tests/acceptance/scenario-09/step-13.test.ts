// T059 фичи 004 — сценарий 9, шаг 9.13: У3 отходит от Станции — по простою блокируется только
// интерфейс; CLI и сеанс с Опорной станцией работают; чтобы продолжить, пароль вводят снова (STATION-11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TEST_STATION_PASSWORD, startNetwork, startStation, uiLogin, waitFor } from "../../support/network.ts";

test("9.13: простой — 423 ui_locked для интерфейса; CLI работает; пароль снимает блокировку", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  let now = Date.now();
  const station = await startStation(t, net, net.seniorId, { clock: () => now });
  const ui = await uiLogin(station);
  assert.equal((await ui.call("POST", "/local/settings", { idleLockMinutes: 1 })).status, 200);
  assert.equal((await ui.call("GET", "/api/members")).status, 200);
  now += 61_000;
  const locked = await ui.call("GET", "/api/members");
  assert.deepEqual([locked.status, locked.body["error"]], [423, "ui_locked"]);
  assert.equal((await ui.call("GET", "/local/state")).body["uiLocked"], true);
  // CLI с токеном локального доступа и сеанс со Станцией блокировка не касается.
  assert.equal((await station.local("GET", "/api/members")).status, 200);
  assert.ok(station.server.part.session !== undefined);
  assert.equal((await ui.call("POST", "/local/unlock", { password: "wrong-password-x" })).body["error"], "password_wrong");
  assert.equal((await ui.call("POST", "/local/unlock", { password: TEST_STATION_PASSWORD })).status, 200);
  assert.equal((await ui.call("GET", "/api/members")).status, 200);
});
