// T037 фичи 004 — Приглашения по contracts/http-api.md: выпуск Старшим с подтверждением присутствия,
// не себе; по STATION-43 — через API сопровождения; перечень без секретов; отмена без присутствия
// (STATION-13, STATION-14, STATION-43, STATION-44; research R7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptKeyHash, decodeBytes, deriveInvitationKeys, parseInvitation } from "@aristotel/protocol";
import { RELAY_X, RELAY_Y, callAs, callMaintenance, groupA, launchTestNetwork, openTestSession, startTestService } from "../../../../tests/support/harness.ts";

test("выпуск: 201 со строкой — Проходы своей записи, отпечаток TLS, срок 72 ч; в БД нет секрета", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc, [RELAY_X, RELAY_Y]);
  const a = groupA(svc.db, svc.seniorId);
  const res = await callAs(svc, a.c1, "POST", "/api/invitations", { memberId: a.u1 });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  const inv = parseInvitation(body.invitation);
  assert.equal(inv.code, "A");
  assert.deepEqual(inv.passages, [RELAY_X.url, RELAY_Y.url]);
  assert.equal(inv.invitationId, body.id);
  assert.match(inv.baseTlsSpki, /^[A-Za-z0-9+/]{43}$/);
  const hours = (Date.parse(inv.expiresAt) - Date.now()) / 3600_000;
  assert.ok(hours > 71.9 && hours <= 72, String(hours));
  const row = svc.db.prepare("SELECT * FROM invitation WHERE id = ?").get(body.id)!;
  const keys = deriveInvitationKeys(decodeBytes(inv.secret, 32)!);
  assert.equal(row["passageKey"], keys.passageKey);
  assert.equal(row["acceptKeyHash"], acceptKeyHash(keys.acceptKey));
  assert.ok(!JSON.stringify(row).includes(inv.secret), "секрета в БД нет");
  const entry = svc.db.prepare("SELECT actorId, details FROM journal WHERE action = 'invitation.issue'").get()!;
  assert.equal(entry["actorId"], a.c1);
  assert.ok(!String(entry["details"]).includes(inv.secret));
  assert.deepEqual(JSON.parse(String(entry["details"])), { memberId: a.u1, expiresAt: inv.expiresAt });
});

test("отказы выпуска: себе, Участник, Наблюдатель, отозванный, без Реестра", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  assert.equal((await callAs(svc, a.c1, "POST", "/api/invitations", { memberId: a.u1 })).json().error, "network_not_launched");
  launchTestNetwork(svc);
  const self = await callAs(svc, a.c1, "POST", "/api/invitations", { memberId: a.c1 });
  assert.equal(self.statusCode, 403);
  assert.equal(self.json().error, "invitation_self");
  for (const actor of [a.u1, a.n1]) assert.equal((await callAs(svc, actor, "POST", "/api/invitations", { memberId: a.u2 })).json().error, "forbidden");
  svc.db.prepare("UPDATE member SET state = 'revoked' WHERE id = ?").run(a.u2);
  const revoked = await callAs(svc, a.c1, "POST", "/api/invitations", { memberId: a.u2 });
  assert.deepEqual([revoked.statusCode, revoked.json().error], [409, "member_not_active"]);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'invitation.issue'").get()?.["n"], 0);
});

test("перечень без строк и секретов; отмена без присутствия, повтор — invitation_not_issued", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc);
  const a = groupA(svc.db, svc.seniorId);
  const issued = (await callAs(svc, a.c1, "POST", "/api/invitations", { memberId: a.u1 })).json();
  const list = await callAs(svc, a.c2!, "GET", "/api/invitations");
  const mine = list.json().items.find((i: { id: string }) => i.id === issued.id);
  assert.deepEqual(Object.keys(mine).sort(), ["expiresAt", "id", "issuedAt", "issuedBy", "memberId", "memberLabel", "view"]);
  assert.equal(mine.view, "issued");
  assert.ok(!list.body.includes(parseInvitation(issued.invitation).secret));
  assert.equal((await callAs(svc, a.u1, "GET", "/api/invitations")).json().error, "forbidden");
  // Отмена — любым Старшим и без подтверждения присутствия (rawInject — без заголовка).
  const session = svc.session(a.c2!);
  const cancel = await svc.rawInject({ method: "POST", url: `/api/invitations/${issued.id}/cancel`, headers: { "aristotel-api-version": "1", authorization: `Bearer ${session.token}` } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().view, "cancelled");
  assert.equal((await callAs(svc, a.c1, "POST", `/api/invitations/${issued.id}/cancel`)).json().error, "invitation_not_issued");
  assert.equal(svc.db.prepare("SELECT actorId FROM journal WHERE action = 'invitation.cancel'").get()?.["actorId"], a.c2);
});

test("выпуск без подтверждения присутствия — 403 presence_required", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc);
  const a = groupA(svc.db, svc.seniorId);
  const session = svc.session(a.c1);
  const res = await svc.rawInject({
    method: "POST",
    url: "/api/invitations",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    payload: { memberId: a.u1 },
  });
  assert.equal(res.json().error, "presence_required");
});

test("STATION-43 через сопровождение: Старшему без других Старших со Станцией; от службы, via cli", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc);
  const a = groupA(svc.db, svc.seniorId);
  // У С2 тестовая Станция есть — Приглашение С1 через CLI не выпускается.
  openTestSession(svc.db, a.c2!);
  const refused = await callMaintenance(svc, "POST", "/api/invitations/senior", { memberId: a.c1 });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, "invitation_senior_has_station");
  svc.db.prepare("UPDATE station SET state = 'revoked', revokedAt = 't', revokeReason = 'revoked' WHERE memberId = ?").run(a.c2!);
  const ok = await callMaintenance(svc, "POST", "/api/invitations/senior", { memberId: a.c1 });
  assert.equal(ok.statusCode, 201, ok.body);
  const entry = svc.db.prepare("SELECT actorId, details FROM journal WHERE action = 'invitation.issue'").get()!;
  assert.equal(entry["actorId"], null);
  assert.equal(JSON.parse(String(entry["details"])).via, "cli");
  assert.equal((await callMaintenance(svc, "POST", "/api/invitations/senior", { memberId: a.u1 })).statusCode, 403, "не Старшему");
  // На API Станций маршрута нет.
  assert.equal((await callAs(svc, a.c1, "POST", "/api/invitations/senior", { memberId: a.c1 })).statusCode, 404);
});
