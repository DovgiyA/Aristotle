// T072 фичи 004 — SC-003: ни одна попытка из перечня отказов не даёт успешного запроса к Банку.
// Станция не из перечня, отозванная после срока, повторное, просроченное и отменённое Приглашение,
// чужой TLS-отпечаток Опорной станции и Ретранслятора, вход Опорной станции с ключом не из Реестра,
// интерфейс без cookie, с чужим Host, без CSRF (STATION-04, STATION-03, STATION-13, STATION-22,
// RELAY-05, RELAY-16, APP-06).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUIDv7 } from "node:crypto";
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  acceptKeyHash,
  decodeBytes,
  deriveInvitationKeys,
  ed25519Sign,
  encodeBytes,
  encodeInvitation,
  parseInvitation,
  relayLoginMessage,
} from "@aristotel/protocol";
import { TlsMismatchError, ensureTlsKey, expireDeleteOnly } from "@aristotel/core";
import { BaseConnector, acceptInvitation, keyFromSeed } from "@aristotel/station";
import { addMember } from "../../support/harness.ts";
import {
  TEST_STATION_PASSWORD,
  TEST_WORK_FACTOR,
  acceptOnStand,
  callStation,
  invitationKnown,
  relayFetch,
  startNetwork,
  startStation,
  tempDir,
  testGroup,
  uiLogin,
  waitFor,
  type TestNetwork,
} from "../../support/network.ts";

/** Отпечаток состояния Банка: Станции, сеансы, Записи, действия Членов Группы в журнале. */
function bankMark(net: TestNetwork): string {
  const row = net.server.db
    .prepare(
      `SELECT (SELECT count(*) FROM station) AS s, (SELECT count(*) FROM station_session) AS ss,
              (SELECT count(*) FROM record) AS r, (SELECT count(*) FROM journal WHERE actorId IS NOT NULL) AS j`,
    )
    .get()!;
  return [row["s"], row["ss"], row["r"], row["j"]].join("/");
}

async function network(t: Parameters<typeof startNetwork>[0]): Promise<TestNetwork> {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  return net;
}

async function issue(net: TestNetwork, memberId: string): Promise<string> {
  const invitation = String((await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId })).json().invitation);
  await invitationKnown(net, invitation);
  return invitation;
}

const accept = (invitation: string, dir: string) =>
  acceptInvitation({ dataDir: dir, invitation, password: TEST_STATION_PASSWORD, workFactor: TEST_WORK_FACTOR, attemptMs: 1500 });

test("SC-003: Станция не из перечня Прохода — Ретранслятор не соединяет", async (t) => {
  const net = await network(t);
  const before = bankMark(net);
  const stranger = keyFromSeed(new Uint8Array(32).fill(0x77));
  const connector = new BaseConnector({
    code: "A",
    passages: [net.relays[0]!.relay.url],
    baseTlsSpki: net.server.tls.tlsSpki,
    signer: { publicKey: stranger.publicKey, sign: (m) => ed25519Sign(stranger.key, m) },
    attemptMs: 1500,
  });
  await assert.rejects(connector.request("POST", "/api/session/challenge"));
  connector.close();
  assert.equal(bankMark(net), before);
});

test("SC-003: Станция отозвана, срок «только удаление» вышел — входа нет", async (t) => {
  const net = await network(t);
  const u1 = addMember(net.server.db, "У1");
  const s1 = await startStation(t, net, u1);
  // Часы стенда: отзыв с коротким сроком, проверка сроков — вручную.
  const from = new Date();
  net.server.db
    .prepare("UPDATE station SET state = 'revoked', revokedAt = ?, revokedBy = ?, revokeReason = 'revoked', deleteOnlyUntil = ? WHERE id = ?")
    .run(from.toISOString(), net.seniorId, new Date(Date.now() + 10).toISOString(), s1.result.stationId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expireDeleteOnly(net.server.db, from);
  await waitFor(() => !net.relays[0]!.server!.passages.listOf("A").some((e) => e.key === s1.result.stationKey), 5000, "ключ ушёл из перечня");
  const before = bankMark(net);
  const res = await s1.local("GET", "/api/members");
  assert.notEqual(res.status, 200);
  assert.equal(s1.server.part.deleted, false);
  assert.equal(bankMark(net), before);
});

test("SC-003: повторное Приглашение — отказ, второй Станции нет", async (t) => {
  const net = await network(t);
  const u1 = addMember(net.server.db, "У1");
  const invitation = await issue(net, u1);
  await acceptOnStand(t, invitation);
  const before = bankMark(net);
  await assert.rejects(accept(invitation, tempDir(t, "aristotel-station-")));
  assert.equal(bankMark(net), before);
});

test("SC-003: отменённое Приглашение — отказ", async (t) => {
  const net = await network(t);
  const u1 = addMember(net.server.db, "У1");
  const invitation = await issue(net, u1);
  const id = parseInvitation(invitation).invitationId;
  assert.equal((await callStation(net, net.seniorId, "POST", `/api/invitations/${id}/cancel`, {})).statusCode, 200);
  await waitFor(() => !net.relays[0]!.server!.passages.listOf("A").some((e) => e.kind === "invitation"), 5000, "ключ Прохода снят");
  const before = bankMark(net);
  await assert.rejects(accept(invitation, tempDir(t, "aristotel-station-")));
  assert.equal(bankMark(net), before);
});

test("SC-003: просроченное Приглашение — отказ", async (t) => {
  const net = await network(t);
  const u1 = addMember(net.server.db, "У1");
  // Приглашение со сроком в прошлом — прямо в БД (часы стенда).
  const secret = new Uint8Array(randomBytes(32));
  const keys = deriveInvitationKeys(secret);
  const id = randomUUIDv7();
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  net.server.db
    .prepare("INSERT INTO invitation (id, memberId, issuedBy, issuedAt, expiresAt, passageKey, acceptKeyHash, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued')")
    .run(id, u1, net.seniorId, new Date(Date.now() - 3600_000).toISOString(), expiresAt, keys.passageKey, acceptKeyHash(keys.acceptKey));
  const invitation = encodeInvitation({ code: "A", invitationId: id, passages: [net.relays[0]!.relay.url], baseTlsSpki: net.server.tls.tlsSpki, secret: encodeBytes(secret), expiresAt });
  const before = bankMark(net);
  await assert.rejects(accept(invitation, tempDir(t, "aristotel-station-")));
  assert.equal(bankMark(net), before);
});

test("SC-003: чужой TLS-отпечаток Опорной станции в Приглашении — Станция рвёт соединение", async (t) => {
  const net = await network(t);
  const u1 = addMember(net.server.db, "У1");
  const parsed = parseInvitation(await issue(net, u1));
  const other = ensureTlsKey(tempDir(t)).tlsSpki;
  const before = bankMark(net);
  await assert.rejects(accept(encodeInvitation({ ...parsed, baseTlsSpki: other }), tempDir(t, "aristotel-station-")), (error: unknown) => error instanceof TlsMismatchError);
  assert.equal(bankMark(net), before);
  assert.equal(net.server.db.prepare("SELECT state FROM invitation WHERE id = ?").get(parsed.invitationId)?.["state"], "issued");
});

test("SC-003: чужой TLS-ключ Ретранслятора — Опорная станция не входит, Станции не соединяются", async (t) => {
  const net = await network(t);
  const u1 = addMember(net.server.db, "У1");
  const invitation = await issue(net, u1);
  const r = net.relays[0]!;
  await r.stop();
  rmSync(join(r.dir, "tls-key.pem"));
  rmSync(join(r.dir, "tls-cert.pem"));
  ensureTlsKey(r.dir);
  await r.start();
  await waitFor(() => net.server.db.prepare("SELECT 1 FROM journal WHERE action = 'relay.tls-mismatch'").get() !== undefined, 5000, "relay.tls-mismatch");
  assert.equal(r.server!.passages.hasControl("A"), false);
  const before = bankMark(net);
  await assert.rejects(accept(invitation, tempDir(t, "aristotel-station-")));
  assert.equal(bankMark(net), before);
});

test("SC-003: вход на Ретранслятор с ключом не из Реестра — 403", async (t) => {
  const net = await network(t);
  const relay = net.relays[0]!;
  const forged = testGroup("A", 0x79);
  const challenge = String((await relayFetch(relay, "POST", "/relay/v1/vhod/vyzov")).body["challenge"]);
  const signature = encodeBytes(ed25519Sign(forged.key, relayLoginMessage("A", decodeBytes(challenge, 32)!, decodeBytes(relay.relay.tlsSpki, 32)!)));
  const res = await relayFetch(relay, "POST", "/relay/v1/vhod", { code: "A", registryNumber: net.registryNumber(), challenge, signature });
  assert.deepEqual([res.status, res.body], [403, { error: "forbidden" }]);
});

function rawRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("SC-003: интерфейс без cookie, с чужим Host, без CSRF — к Банку не доходит", async (t) => {
  const net = await network(t);
  const station = await startStation(t, net);
  const ui = await uiLogin(station);
  const port = station.server.port;
  const body = JSON.stringify({ type: "test.note", fields: { x: "v" } });
  const before = bankMark(net);
  const json = { "content-type": "application/json", origin: `http://127.0.0.1:${port}` };
  assert.equal(await rawRequest(port, "POST", "/api/records", { ...json, host: `127.0.0.1:${port}` }, body), 401, "без cookie");
  assert.equal(await rawRequest(port, "POST", "/api/records", { ...json, host: `evil.test:${port}`, cookie: ui.cookie, "aristotel-csrf": ui.csrf }, body), 421, "чужой Host");
  assert.equal(await rawRequest(port, "POST", "/api/records", { ...json, host: `127.0.0.1:${port}`, cookie: ui.cookie }, body), 403, "без CSRF");
  assert.equal(bankMark(net), before);
});
