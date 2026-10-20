// T038 фичи 004 — приём Станции по contracts/stanciya-v1.md: верный ключ приёма — Станция за Членом
// Группы, Приглашение использовано, журнал, перечень Прохода; любая причина отказа — один ответ
// invitation_invalid; ключ занят — station_key_taken; одно Приглашение — одна Станция (STATION-13,
// STATION-16; research R7).
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { decodeBytes, deriveInvitationKeys, ed25519FromSeed, encodeBytes, keyFingerprint, parseInvitation, publicKeyText } from "@aristotel/protocol";
import { networkEvents, passageList } from "@aristotel/core";
import { callAs, groupA, launchTestNetwork, startTestService, type TestService } from "../../../../tests/support/harness.ts";

const newStationKey = () => publicKeyText(ed25519FromSeed(new Uint8Array(randomBytes(32))));

async function invite(svc: TestService, by: string, memberId: string) {
  const res = await callAs(svc, by, "POST", "/api/invitations", { memberId });
  assert.equal(res.statusCode, 201, res.body);
  const inv = parseInvitation(res.json().invitation);
  return { inv, keys: deriveInvitationKeys(decodeBytes(inv.secret, 32)!) };
}

function accept(svc: TestService, body: Record<string, unknown>) {
  return svc.rawInject({ method: "POST", url: "/api/stations/accept", headers: { "aristotel-api-version": "1", "content-type": "application/json" }, payload: body });
}

test("приём: Станция действует за Членом Группы, журнал station.accept, перечень Прохода разослан", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc);
  const a = groupA(svc.db, svc.seniorId);
  const { inv, keys } = await invite(svc, a.c1, a.u1);
  assert.ok(passageList(svc.db).some((e) => e.kind === "invitation" && e.key === keys.passageKey));
  let broadcasts = 0;
  const count = () => void broadcasts++;
  networkEvents.on("passage-list-changed", count);
  t.after(() => networkEvents.off("passage-list-changed", count));
  const stationKey = newStationKey();
  const res = await accept(svc, { invitationId: inv.invitationId, acceptKey: encodeBytes(keys.acceptKey), stationKey });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.memberId, a.u1);
  assert.equal(body.memberLabel, "У1");
  assert.equal(body.role, "participant");
  assert.equal(body.code, "A");
  assert.deepEqual(body.passages, inv.passages);
  const station = svc.db.prepare("SELECT * FROM station WHERE id = ?").get(body.stationId)!;
  assert.equal(station["state"], "active");
  assert.equal(station["memberId"], a.u1);
  assert.equal(svc.db.prepare("SELECT state FROM invitation WHERE id = ?").get(inv.invitationId)?.["state"], "used");
  const entry = svc.db.prepare("SELECT actorId, details FROM journal WHERE action = 'station.accept'").get()!;
  assert.equal(entry["actorId"], a.u1);
  assert.deepEqual(JSON.parse(String(entry["details"])), { invitationId: inv.invitationId, keyFingerprint: keyFingerprint(stationKey) });
  const list = passageList(svc.db);
  assert.ok(list.some((e) => e.kind === "station" && e.key === stationKey));
  assert.ok(!list.some((e) => e.key === keys.passageKey), "ключ Прохода Приглашения ушёл");
  assert.ok(broadcasts >= 1);
  const stations = (await callAs(svc, a.c1, "GET", "/api/stations")).json().items;
  assert.ok(stations.some((s: { id: string; view: string; keyFingerprint: string }) => s.id === body.stationId && s.view === "active" && s.keyFingerprint === keyFingerprint(stationKey)));
});

test("отказы приёма — один ответ invitation_invalid; ключ занят — station_key_taken", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc);
  const a = groupA(svc.db, svc.seniorId);
  const expectInvalid = async (body: Record<string, unknown>, label: string) => {
    const res = await accept(svc, body);
    assert.equal(res.statusCode, 403, label);
    assert.deepEqual(Object.keys(res.json()).sort(), ["error", "message"], label);
    assert.equal(res.json().error, "invitation_invalid", label);
  };
  const first = await invite(svc, a.c1, a.u1);
  await expectInvalid({ invitationId: first.inv.invitationId, acceptKey: encodeBytes(new Uint8Array(32)), stationKey: newStationKey() }, "неверный ключ приёма");
  await expectInvalid({ invitationId: "нет-такого", acceptKey: encodeBytes(first.keys.acceptKey), stationKey: newStationKey() }, "нет Приглашения");
  const taken = newStationKey();
  assert.equal((await accept(svc, { invitationId: first.inv.invitationId, acceptKey: encodeBytes(first.keys.acceptKey), stationKey: taken })).statusCode, 201);
  await expectInvalid({ invitationId: first.inv.invitationId, acceptKey: encodeBytes(first.keys.acceptKey), stationKey: newStationKey() }, "использовано");
  const cancelled = await invite(svc, a.c1, a.u2);
  await callAs(svc, a.c1, "POST", `/api/invitations/${cancelled.inv.invitationId}/cancel`);
  await expectInvalid({ invitationId: cancelled.inv.invitationId, acceptKey: encodeBytes(cancelled.keys.acceptKey), stationKey: newStationKey() }, "отменено");
  const expired = await invite(svc, a.c1, a.u2);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 73 * 3600_000 });
  await expectInvalid({ invitationId: expired.inv.invitationId, acceptKey: encodeBytes(expired.keys.acceptKey), stationKey: newStationKey() }, "истекло");
  t.mock.timers.reset();
  const revoked = await invite(svc, a.c1, a.n1);
  svc.db.prepare("UPDATE member SET state = 'revoked' WHERE id = ?").run(a.n1);
  await expectInvalid({ invitationId: revoked.inv.invitationId, acceptKey: encodeBytes(revoked.keys.acceptKey), stationKey: newStationKey() }, "Член Группы отозван после выпуска");
  const again = await invite(svc, a.c1, a.u2);
  const res = await accept(svc, { invitationId: again.inv.invitationId, acceptKey: encodeBytes(again.keys.acceptKey), stationKey: taken });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "station_key_taken");
});

test("50 пар одновременных приёмов по одному Приглашению — ровно одна Станция", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc);
  const a = groupA(svc.db, svc.seniorId);
  for (let i = 0; i < 50; i++) {
    const { inv, keys } = await invite(svc, a.c1, a.u1);
    const body = (stationKey: string) => ({ invitationId: inv.invitationId, acceptKey: encodeBytes(keys.acceptKey), stationKey });
    const results = await Promise.all([accept(svc, body(newStationKey())), accept(svc, body(newStationKey()))]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 403], `пара ${i}`);
    assert.equal(svc.db.prepare("SELECT count(*) AS n FROM station WHERE invitationId = ?").get(inv.invitationId)?.["n"], 1);
  }
});
