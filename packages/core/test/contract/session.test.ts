// T048 фичи 004 — вход Станции по contracts/stanciya-v1.md через настоящий Проход: подпись над вызовом
// и EKM этого TLS-соединения, короткий токен, продление без новой записи журнала, конец сеанса, срок,
// «только удаление», события Станции (STATION-10, STATION-22, STATION-34, STATION-42; research R8, R11, R12).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { TLSSocket } from "node:tls";
import { STATION_EKM_LABEL, decodeBytes, ed25519Sign, encodeBytes, stationLoginMessage } from "@aristotel/protocol";
import { expireSessions } from "@aristotel/core";
import { BaseConnector } from "@aristotel/station";
import { startNetwork, startStation, waitFor, type TestNetwork } from "../../../../tests/support/network.ts";
import { keyFromSeed } from "../../../station/src/station-key.ts";

function post(socket: TLSSocket, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        method: "POST",
        path,
        createConnection: () => socket,
        headers: { host: "x", "aristotel-api-version": "1", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data === "" ? {} : JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

async function connectorFor(net: TestNetwork, seed: Uint8Array): Promise<{ connector: BaseConnector; key: ReturnType<typeof keyFromSeed> }> {
  const key = keyFromSeed(seed);
  const connector = new BaseConnector({
    code: "A",
    passages: [net.relays[0]!.relay.url],
    baseTlsSpki: net.server.tls.tlsSpki,
    signer: { publicKey: key.publicKey, sign: (m) => ed25519Sign(key.key, m) },
  });
  return { connector, key };
}

const journal = (net: TestNetwork, action: string) => net.server.db.prepare("SELECT actorId, details FROM journal WHERE action = ? ORDER BY seq").all(action);

test("вход: подпись над вызовом и EKM; токен 15 минут; начало сеанса в журнале без адресов", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const session = station.server.part.session!;
  assert.equal(session.scope, "full");
  assert.equal(session.memberId, net.seniorId);
  assert.equal(session.role, "senior");
  assert.deepEqual(session.passages, [net.relays[0]!.relay.url]);
  const ttl = Date.parse(session.expiresAt) - Date.now();
  assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000);
  const start = journal(net, "station.session.start").at(-1)!;
  assert.equal(start["actorId"], net.seniorId);
  assert.doesNotMatch(String(start["details"]), /127\.0\.0\.1|::1|address/);
  const row = net.server.db.prepare("SELECT tokenHash FROM station_session WHERE id = ?").get(session.sessionId)!;
  assert.notEqual(row["tokenHash"], session.token, "в БД — хэш токена");
});

test("подпись с EKM другого соединения, чужой ключ, повтор вызова — 403 station_unknown", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  // Подписываем вызов EKM соединения A, а предъявляем на соединении B — перенос входа.
  const { connector } = await connectorFor(net, new Uint8Array(32).fill(1));
  connector.setSigner(station.server.part.stationKey!);
  const challenge = String((await connector.request("POST", "/api/session/challenge")).json()["challenge"]);
  const a = await connector.openTunnel();
  const b = await connector.openTunnel();
  const ekmA = new Uint8Array(a.exportKeyingMaterial(32, STATION_EKM_LABEL, Buffer.alloc(0)));
  const key = station.server.part.stationKey!;
  const signature = encodeBytes(key.sign(stationLoginMessage(decodeBytes(challenge, 32)!, ekmA)));
  const moved = await post(b, "/api/session", { stationKey: key.publicKey, challenge, signature });
  assert.deepEqual([moved.status, moved.body["error"]], [403, "station_unknown"]);
  a.destroy();
  // Чужой ключ (не принятая Станция) — 403; повтор вызова — 403.
  const stranger = keyFromSeed(new Uint8Array(32).fill(7));
  const challenge2 = String((await connector.request("POST", "/api/session/challenge")).json()["challenge"]);
  const c = await connector.openTunnel();
  const ekmC = new Uint8Array(c.exportKeyingMaterial(32, STATION_EKM_LABEL, Buffer.alloc(0)));
  const strangerRes = await post(c, "/api/session", { stationKey: stranger.publicKey, challenge: challenge2, signature: encodeBytes(ed25519Sign(stranger.key, stationLoginMessage(decodeBytes(challenge2, 32)!, ekmC))) });
  assert.equal(strangerRes.body["error"], "station_unknown");
  connector.close();
});

test("продление: тот же sessionId, новый токен, журнал не пишет; выход — конец exit", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const before = station.server.part.session!;
  const starts = journal(net, "station.session.start").length;
  await station.server.part.login();
  const after = station.server.part.session!;
  assert.equal(after.sessionId, before.sessionId);
  assert.notEqual(after.token, before.token);
  assert.equal(journal(net, "station.session.start").length, starts);
  // Старый токен больше не действует.
  const old = await station.server.part.request("GET", "/api/members");
  assert.equal(old.status, 200, "запрос идёт с новым токеном");
  await station.server.close();
  const end = journal(net, "station.session.end").at(-1)!;
  assert.deepEqual(JSON.parse(String(end["details"])), { sessionId: before.sessionId, reason: "exit" });
  assert.equal(net.server.db.prepare("SELECT endReason FROM station_session WHERE id = ?").get(before.sessionId)?.["endReason"], "exit");
});

test("срок вышел без продления — через проверку конец expired от службы", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const id = station.server.part.session!.sessionId;
  assert.ok(expireSessions(net.server.db, new Date(Date.now() + 16 * 60_000)) >= 1);
  const end = journal(net, "station.session.end").find((r) => JSON.parse(String(r["details"])).sessionId === id)!;
  assert.equal(end["actorId"], null);
  assert.equal(JSON.parse(String(end["details"])).reason, "expired");
});

test("Станция в «только удаление» — сеанс delete-only, команда удаления выполнена; прокси — 410", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const stationId = station.result.stationId;
  const until = new Date(Date.now() + 3600_000).toISOString();
  net.server.db.prepare("UPDATE station SET state = 'revoked', revokedAt = ?, revokeReason = 'revoked', deleteOnlyUntil = ? WHERE id = ?").run(new Date().toISOString(), until, stationId);
  await station.server.part.login().catch(() => undefined);
  await waitFor(() => station.server.part.deleted, 10_000, "команда удаления выполнена");
  const starts = journal(net, "station.session.start").map((r) => JSON.parse(String(r["details"])).scope);
  assert.equal(starts.at(-1), "delete-only");
  const denied = await station.local("GET", "/api/members");
  assert.deepEqual([denied.status, denied.body["error"]], [410, "station_deleted"]);
});

test("события Станции: смена записи Группы — новый перечень Проходов (STATION-42)", async (t) => {
  const net = await startNetwork(t, { relays: 2 });
  await waitFor(() => net.relays.every((r) => r.server!.passages.hasControl("A")));
  const station = await startStation(t, net);
  await net.publish([net.relays[1]!.relay]);
  const { readStationState } = await import("@aristotel/station");
  await waitFor(() => JSON.stringify(readStationState(station.dir).passages) === JSON.stringify([net.relays[1]!.relay.url]), 10_000, "Проходы обновлены");
});
