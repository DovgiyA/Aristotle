// T015 фичи 002, T067 фичи 004 — сценарий 10, шаг 10.5: С1 отзывает У2 — отзыв действует сразу,
// отозваны все Станции У2 (S2 и S2'), их сеансы закрыты; авторство У2 в истории и журнале остаётся
// (STATION-17, STATION-18; SC-005). Поручения — фича 016, Задачи и черновики — фичи 010 и 013.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMember, callAs, startTestService } from "../../support/harness.ts";
import { callStation, startNetwork, startStation, waitFor } from "../../support/network.ts";

test("10.5: С1 отзывает У2 — от его имени больше ничего, авторство на месте", async (t) => {
  const svc = await startTestService(t);
  const u2 = svc.addMember("У2");
  const created = (await callAs(svc, u2, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const url = `/api/records/${created.id}`;
  assert.equal((await callAs(svc, u2, "PATCH", url, { expectedVersion: 1, fields: { x: "w" } })).statusCode, 200);

  const revoked = await callAs(svc, svc.seniorId, "POST", `/api/members/${u2}/revoke`, { expectedVersion: 1 });
  assert.equal(revoked.statusCode, 200);

  // Отзыв действует с первого же следующего запроса — и на чтение, и на изменение (SC-005): Станция
  // У2 отозвана вместе с ним, её сеанс закрыт (STATION-18, фича 004).
  for (const res of [
    await callAs(svc, u2, "GET", url),
    await callAs(svc, u2, "PATCH", url, { expectedVersion: 2, fields: { x: "y" } }),
    await callAs(svc, u2, "GET", "/api/journal"),
  ]) {
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, "session_required");
  }

  // Авторство У2 в истории Записи и журнале остаётся (STATION-18).
  const history = (await callAs(svc, svc.seniorId, "GET", `${url}/history`)).json().items;
  assert.deepEqual(history.map((h: { authorId: string }) => h.authorId), [u2, u2]);
  const journal = (await callAs(svc, svc.seniorId, "GET", `/api/journal?member=${u2}`)).json().items;
  assert.deepEqual(journal.map((j: { action: string; actorLabel: string }) => [j.action, j.actorLabel]), [
    ["record.create", "У2"],
    ["record.update", "У2"],
  ]);
  assert.equal((await callAs(svc, svc.seniorId, "GET", url)).json().fields.x, "w");
});

test("10.5: отзыв У2 отзывает S2 и S2', сеансы закрыты, авторство У2 в силе", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u2 = addMember(net.server.db, "У2");
  const s2 = await startStation(t, net, u2);
  const s2b = await startStation(t, net, u2);
  const created = await s2.local("POST", "/api/records", { type: "test.note", fields: { x: "v" } });
  assert.equal(created.status, 201, created.text);
  const sessions = [s2.server.part.session!.sessionId, s2b.server.part.session!.sessionId];
  const res = await callStation(net, net.seniorId, "POST", `/api/members/${u2}/revoke`, { expectedVersion: 1 });
  assert.equal(res.statusCode, 200, res.body);
  for (const s of [s2, s2b]) {
    const row = net.server.db.prepare("SELECT state, revokeReason, revokedBy FROM station WHERE id = ?").get(s.result.stationId);
    assert.deepEqual([row?.["state"], row?.["revokeReason"], row?.["revokedBy"]], ["revoked", "member-revoked", net.seniorId]);
    await waitFor(() => s.server.part.session?.scope !== "full", 5000, "Станция У2 потеряла сеанс");
  }
  for (const id of sessions) assert.equal(net.server.db.prepare("SELECT endReason FROM station_session WHERE id = ?").get(id)?.["endReason"], "revoked");
  const authored = net.server.db.prepare("SELECT actorId FROM journal WHERE action = 'record.create' AND subjectId = ?").get(String(created.body["id"]));
  assert.equal(authored?.["actorId"], u2);
  const journal = net.server.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'station.revoke' AND actorId = ?").get(net.seniorId);
  assert.equal(Number(journal?.["n"]), 2);
});
