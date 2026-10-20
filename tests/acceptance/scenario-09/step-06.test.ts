// T050 фичи 004 — сценарий 9, шаг 9.6: пароль открывает Ключ станции; Станция соединяется с Опорной
// станцией только через Проход; вход — подписанным вызовом, токен короткоживущий; внутри — TLS 1.3 с
// закреплённым отпечатком — SHA-256 открытого ключа; перечень Проходов при входе; другой отпечаток —
// не соединяется (STATION-01, STATION-03, STATION-09, STATION-10, STATION-40 … STATION-42).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FAST_RELAY_TIMERS, startNetwork, startStation, waitFor } from "../../support/network.ts";

test("9.6: вход через Проход, TLS 1.3 с закреплённым SPKI, короткий токен, Проходы при входе", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const state = station.server.part.state();
  assert.equal(state.unlocked, true);
  assert.equal(state.passage, net.relays[0]!.relay.url, "соединение — через Проход");
  assert.equal(state.baseTlsSpki, net.server.tls.tlsSpki);
  const session = station.server.part.session!;
  assert.ok(Date.parse(session.expiresAt) - Date.now() <= 15 * 60_000);
  assert.deepEqual(session.passages, [net.relays[0]!.relay.url]);
  // У Опорной станции нет входящих портов, кроме loopback; API Станций портов не слушает (RELAY-03).
  assert.match((net.server.app.server.address() as AddressInfo).address, /^(127\.0\.0\.1|::1)$/);
  assert.equal(net.server.stationApp.server.listening, false);
  assert.equal((await station.local("GET", "/api/members")).status, 200);
});

test("9.6: Опорная станция с другим TLS-ключом — Станция не соединяется, видит оба отпечатка", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  await station.server.close();
  await net.server.close();
  rmSync(join(net.dir, "tls-key.pem"));
  rmSync(join(net.dir, "tls-cert.pem"));
  const { startServer } = await import("@aristotel/core");
  const server = await startServer({ dataDir: net.dir, relayTimers: FAST_RELAY_TIMERS });
  t.after(() => server.close());
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"), 5000, "вход после перезапуска");
  const { startLocalServer } = await import("@aristotel/station");
  const local = await startLocalServer({ dataDir: station.dir, attemptMs: 2000, retryMs: 100 });
  t.after(() => local.close());
  await local.part.unlock("test-password-x");
  await waitFor(() => local.part.state().tlsMismatch !== null, 10_000, "несовпадение отпечатка");
  const mismatch = local.part.state().tlsMismatch!;
  assert.equal(mismatch.expected, net.server.tls.tlsSpki);
  assert.equal(mismatch.seen, server.tls.tlsSpki);
  assert.equal(local.part.session, undefined);
});
