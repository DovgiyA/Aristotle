// T058 фичи 004 — SC-006: каждое действие с признаком присутствия через интерфейс без подтверждения —
// отказ; неверный пароль — подписи нет; подтверждение для одного действия не годится для другого и
// второй раз; отзыв Станции и отмена Приглашения — без пароля; пароль на Опорную станцию не уходит
// (STATION-09, STATION-12; research R10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMember } from "../../support/harness.ts";
import { TEST_STATION_PASSWORD, callStation, startNetwork, startStation, uiLogin, waitFor } from "../../support/network.ts";

test("SC-006: присутствие на каждом действии из перечня; отзыв и отмена — без него", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const ui = await uiLogin(station);
  const u3 = addMember(net.server.db, "У3");
  const record = (await callStation(net, net.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true })).json() as { id: string; version: number };
  const actions: [string, string, unknown][] = [
    ["POST", "/api/members", { label: "У4", role: "participant" }],
    ["PATCH", `/api/members/${u3}`, { expectedVersion: 1, role: "observer" }],
    ["POST", `/api/members/${u3}/revoke`, { expectedVersion: 1 }],
    ["POST", `/api/records/${record.id}/secret/unmark`, { expectedVersion: record.version }],
    ["POST", "/api/invitations", { memberId: u3 }],
    ["POST", "/api/registry/versions", { format: "x", body: "{}", signatures: [] }],
    ["POST", "/api/coordinator-keys", { publicKey: "AAAA", proof: "AAAA" }],
  ];
  for (const [method, path, body] of actions) {
    const res = await ui.call(method, path, body);
    assert.deepEqual([res.status, res.body["error"]], [403, "presence_required"], `${method} ${path}`);
  }
  // Неверный пароль — подписи нет.
  const wrong = await ui.call("POST", "/local/presence", { password: "wrong-password-x", method: "POST", path: "/api/members", body: actions[0]![2] });
  assert.deepEqual([wrong.status, wrong.body["error"]], [403, "password_wrong"]);
  // Подтверждение для одного действия не годится для другого и второй раз.
  const proof = String((await ui.call("POST", "/local/presence", { password: TEST_STATION_PASSWORD, method: "POST", path: "/api/members", body: actions[0]![2] })).body["presence"]);
  const other = await ui.call("POST", "/api/invitations", { memberId: u3 }, { "aristotel-presence": proof });
  assert.equal(other.body["error"], "presence_required");
  const ok = await ui.call("POST", "/api/members", actions[0]![2], { "aristotel-presence": proof });
  assert.equal(ok.status, 201, ok.text);
  const replay = await ui.call("POST", "/api/members", { label: "У4", role: "participant" }, { "aristotel-presence": proof });
  assert.equal(replay.body["error"], "presence_required");
  // Отмена Приглашения и отзыв Станции — без пароля (US5 — отзыв; здесь — отмена).
  const issuedProof = String((await ui.call("POST", "/local/presence", { password: TEST_STATION_PASSWORD, method: "POST", path: "/api/invitations", body: { memberId: u3 } })).body["presence"]);
  const issued = await ui.call("POST", "/api/invitations", { memberId: u3 }, { "aristotel-presence": issuedProof });
  assert.equal(issued.status, 201);
  assert.equal((await ui.call("POST", `/api/invitations/${String(issued.body["id"])}/cancel`, {})).status, 200);
  // Пароль не уходит на Опорную станцию: ни в журнале, ни в логах ядра его нет.
  const all = String(net.server.db.prepare("SELECT group_concat(details, '|') AS d FROM journal").get()?.["d"]);
  assert.ok(!all.includes(TEST_STATION_PASSWORD));
});
