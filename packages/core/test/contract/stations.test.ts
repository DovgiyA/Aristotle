// T066 фичи 004 — Станции по contracts/http-api.md и contracts/stanciya-v1.md: вид «Станции» Старшим,
// отзыв и сдача без присутствия, «только удаление» на срок Группы, команда удаления, параметры
// Группы, отзыв Члена Группы отзывает его Станции, отзыв посреди запроса (STATION-17, STATION-18,
// STATION-20, STATION-22, VIEW-47; research R11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deletionMessage, ed25519Sign, encodeBytes } from "@aristotel/protocol";
import { passageList } from "@aristotel/core";
import { callAs, countRows, openTestSession, startTestService, type TestService, type TestSession } from "../../../../tests/support/harness.ts";

const journalOf = (svc: TestService, action: string) => svc.db.prepare("SELECT actorId, subjectId, details FROM journal WHERE action = ? ORDER BY seq").all(action);

async function asSession(svc: TestService, session: TestSession, method: "GET" | "POST", url: string, payload?: unknown) {
  const headers: Record<string, string> = { "aristotel-api-version": "1", authorization: `Bearer ${session.token}` };
  if (payload === undefined) return await svc.rawInject({ method, url, headers });
  return await svc.rawInject({ method, url, headers: { ...headers, "content-type": "application/json" }, payload: payload as Record<string, unknown> });
}

test("GET /api/stations — только Старший; поля и view", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const s = openTestSession(svc.db, u1);
  const list = await callAs(svc, svc.seniorId, "GET", "/api/stations");
  assert.equal(list.statusCode, 200);
  const item = list.json().items.find((x: { id: string }) => x.id === s.stationId);
  assert.deepEqual([item.memberLabel, item.state, item.view, item.revokedAt, item.deleteOnlyUntil], ["У1", "active", "active", null, null]);
  assert.match(item.keyFingerprint, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  assert.notEqual(item.lastSession, null);
  assert.equal((await callAs(svc, u1, "GET", "/api/stations")).statusCode, 403);
});

test("отзыв: без присутствия, срок «только удаление», сеансы закрыты, журнал; повтор — 409; Участник — 403", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const s = openTestSession(svc.db, u1);
  assert.equal((await callAs(svc, u1, "POST", `/api/stations/${s.stationId}/revoke`, { reason: "revoked" })).statusCode, 403);
  const before = Date.now();
  // Без заголовка присутствия: rawInject не добавляет его.
  const res = await asSession(svc, svc.session(svc.seniorId), "POST", `/api/stations/${s.stationId}/revoke`, { reason: "revoked" });
  assert.equal(res.statusCode, 200, res.body);
  const view = res.json();
  assert.deepEqual([view.state, view.view, view.revokeReason], ["revoked", "delete-only", "revoked"]);
  const days = (Date.parse(view.deleteOnlyUntil) - before) / 86_400_000;
  assert.ok(days > 89.99 && days < 90.01, String(days));
  const session = svc.db.prepare("SELECT endReason FROM station_session WHERE id = ?").get(s.sessionId);
  assert.equal(session?.["endReason"], "revoked");
  const entry = journalOf(svc, "station.revoke").at(-1)!;
  assert.deepEqual([entry["actorId"], entry["subjectId"], JSON.parse(String(entry["details"])).reason], [svc.seniorId, s.stationId, "revoked"]);
  // Прежний токен больше не пускает; в перечне Прохода ключ — с пометкой delete-only.
  assert.equal((await asSession(svc, s, "GET", "/api/members")).statusCode, 401);
  const entry0 = passageList(svc.db).find((e) => e.key === s.publicKey);
  assert.equal(entry0?.kind === "station" ? entry0.state : undefined, "delete-only");
  const again = await callAs(svc, svc.seniorId, "POST", `/api/stations/${s.stationId}/revoke`, { reason: "revoked" });
  assert.deepEqual([again.statusCode, again.json().error], [409, "station_not_active"]);
  assert.equal((await callAs(svc, svc.seniorId, "POST", "/api/stations/nope/revoke", { reason: "revoked" })).statusCode, 404);
});

test("сдача — revokeReason handover; команда удаления в сеансе delete-only; неверная подпись — отказ", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const s = openTestSession(svc.db, u1);
  const res = await callAs(svc, svc.seniorId, "POST", `/api/stations/${s.stationId}/revoke`, { reason: "handover" });
  assert.equal(res.json().revokeReason, "handover");
  // Станция вошла снова — сеанс delete-only (вход проверяет session.test.ts; здесь — прямо в БД).
  const d = openTestSession(svc.db, u1, { scope: "delete-only" });
  svc.db.prepare("UPDATE station_session SET stationId = ? WHERE id = ?").run(s.stationId, d.sessionId);
  const ds: TestSession = { ...d, stationId: s.stationId, key: s.key, publicKey: s.publicKey };
  assert.equal((await asSession(svc, ds, "GET", "/api/members")).json().error, "station_delete_only");
  const command = await asSession(svc, ds, "GET", "/api/station/deletion");
  assert.equal(command.statusCode, 200, command.body);
  assert.deepEqual(command.json().items, ["station-key"]);
  const commandId = String(command.json().commandId);
  const bad = await asSession(svc, ds, "POST", "/api/station/deletion/confirm", { commandId, signature: encodeBytes(ed25519Sign(s.key, deletionMessage(s.stationId, "other"))) });
  assert.deepEqual([bad.statusCode, bad.json().error], [403, "station_unknown"]);
  const ok = await asSession(svc, ds, "POST", "/api/station/deletion/confirm", { commandId, signature: encodeBytes(ed25519Sign(s.key, deletionMessage(s.stationId, commandId))) });
  assert.equal(ok.statusCode, 200, ok.body);
  const entry = journalOf(svc, "station.deletion.confirm").at(-1)!;
  assert.deepEqual([entry["actorId"], entry["subjectId"]], [null, s.stationId]);
  // Конец сеанса удаления — в журнале, как у любого сеанса (STATION-34).
  const ends = journalOf(svc, "station.session.end").map((r) => JSON.parse(String(r["details"])));
  assert.ok(ends.some((d) => d.sessionId === ds.sessionId && d.reason === "exit"), JSON.stringify(ends));
  assert.equal(passageList(svc.db).some((e) => e.key === s.publicKey), false);
  const after = (await callAs(svc, svc.seniorId, "GET", "/api/stations")).json().items.find((x: { id: string }) => x.id === s.stationId);
  assert.equal(after.view, "revoked");
  assert.notEqual(after.deletionConfirmedAt, null);
});

test("сеанс delete-only после срока — 401; команда удаления в полном сеансе — 403", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const s = openTestSession(svc.db, u1);
  assert.equal((await asSession(svc, s, "GET", "/api/station/deletion")).json().error, "station_delete_only");
  svc.db.prepare("UPDATE station SET state = 'revoked', revokedAt = ?, revokeReason = 'revoked', deleteOnlyUntil = ? WHERE id = ?").run(new Date().toISOString(), new Date(Date.now() - 1000).toISOString(), s.stationId);
  svc.db.prepare("UPDATE station_session SET scope = 'delete-only' WHERE id = ?").run(s.sessionId);
  assert.equal((await asSession(svc, s, "GET", "/api/station/deletion")).statusCode, 401);
});

test("параметры Группы: читают все, меняет Старший в пределах; журнал group-setting.update", async (t) => {
  const svc = await startTestService(t);
  const o1 = svc.addMember("Н1", "observer");
  assert.deepEqual((await callAs(svc, o1, "GET", "/api/group-settings")).json(), { invitationHours: 72, deleteOnlyDays: 90 });
  assert.equal((await callAs(svc, o1, "PATCH", "/api/group-settings", { deleteOnlyDays: 30 })).statusCode, 403);
  for (const body of [{ deleteOnlyDays: 0 }, { deleteOnlyDays: 366 }, { invitationHours: 169 }, {}]) {
    assert.equal((await callAs(svc, svc.seniorId, "PATCH", "/api/group-settings", body)).statusCode, 400, JSON.stringify(body));
  }
  const res = await callAs(svc, svc.seniorId, "PATCH", "/api/group-settings", { deleteOnlyDays: 30, invitationHours: 24 });
  assert.deepEqual(res.json(), { invitationHours: 24, deleteOnlyDays: 30 });
  const entry = journalOf(svc, "group-setting.update").at(-1)!;
  assert.equal(entry["actorId"], svc.seniorId);
  assert.deepEqual(JSON.parse(String(entry["details"])), { invitationHours: 24, deleteOnlyDays: 30 });
  const u1 = svc.addMember("У1");
  const s = openTestSession(svc.db, u1);
  const revoked = (await callAs(svc, svc.seniorId, "POST", `/api/stations/${s.stationId}/revoke`, { reason: "revoked" })).json();
  const days = (Date.parse(revoked.deleteOnlyUntil) - Date.parse(revoked.revokedAt)) / 86_400_000;
  assert.equal(Math.round(days), 30);
});

test("отзыв Члена Группы отзывает все его Станции в той же транзакции (STATION-18)", async (t) => {
  const svc = await startTestService(t);
  const u2 = svc.addMember("У2");
  const a = openTestSession(svc.db, u2);
  const b = openTestSession(svc.db, u2);
  const res = await callAs(svc, svc.seniorId, "POST", `/api/members/${u2}/revoke`, { expectedVersion: 1 });
  assert.equal(res.statusCode, 200, res.body);
  for (const s of [a, b]) {
    const row = svc.db.prepare("SELECT state, revokeReason, revokedBy FROM station WHERE id = ?").get(s.stationId);
    assert.deepEqual([row?.["state"], row?.["revokeReason"], row?.["revokedBy"]], ["revoked", "member-revoked", svc.seniorId]);
    assert.equal(svc.db.prepare("SELECT endReason FROM station_session WHERE id = ?").get(s.sessionId)?.["endReason"], "revoked");
  }
});

test("Станцию отзывают между хуком сеанса и транзакцией — 401 session_required, Запись не меняется", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const s = svc.session(u1);
  svc.app.addHook("preHandler", async (request) => {
    if (request.headers["x-test-race"] !== undefined) {
      svc.db.prepare("UPDATE station SET state = 'revoked', revokedAt = ?, revokeReason = 'revoked', deleteOnlyUntil = ? WHERE id = ?").run(new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), s.stationId);
    }
  });
  const before = ["record", "record_history", "journal"].map((x) => countRows(svc.db, x as "record"));
  const res = await svc.app.inject({
    method: "POST",
    url: "/api/records",
    headers: { ...svc.authHeaders(u1), "content-type": "application/json", "x-test-race": "1" },
    payload: { type: "test.note", fields: { x: "v" } },
  });
  assert.deepEqual([res.statusCode, res.json().error], [401, "session_required"]);
  assert.deepEqual(["record", "record_history", "journal"].map((x) => countRows(svc.db, x as "record")), before);
});
