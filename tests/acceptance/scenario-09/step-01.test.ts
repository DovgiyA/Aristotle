// T059 фичи 004 — сценарий 9, шаг 9.1: С1 заводит Члена Группы У3 с ролью Участник — нужен повторный
// ввод пароля; запись Члена Группы — Идентификатор, подпись, роль, состояние (ROLE-03, ROLE-08,
// ROLE-21, STATION-12); интерфейс говорит с Опорной станцией через API локальной части (APP-04).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TEST_STATION_PASSWORD, startNetwork, startStation, uiLogin, waitFor } from "../../support/network.ts";

test("9.1: заведение У3 в интерфейсе — без пароля отказ, с ним — запись Члена Группы", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const ui = await uiLogin(await startStation(t, net));
  const body = { label: "У3", role: "participant" };
  assert.equal((await ui.call("POST", "/api/members", body)).body["error"], "presence_required");
  const presence = String((await ui.call("POST", "/local/presence", { password: TEST_STATION_PASSWORD, method: "POST", path: "/api/members", body })).body["presence"]);
  const created = await ui.call("POST", "/api/members", body, { "aristotel-presence": presence });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(Object.keys(created.body).sort(), ["createdAt", "id", "label", "role", "state", "version"]);
  assert.deepEqual([created.body["label"], created.body["role"], created.body["state"]], ["У3", "participant", "active"]);
});
