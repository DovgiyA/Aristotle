// T027 фичи 004 — US1, сценарии 1–11: Ретранслятор с Проходом и Опорная станция, которая входит на
// Ретрансляторы своей записи Ключом Группы и держит управляющие соединения (RELAY-08, RELAY-10,
// RELAY-11, RELAY-16 … RELAY-19, RELAY-21, RELAY-25, STATION-02, STATION-05, NET-08, NET-17, INBOX-30).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serializeSignedDocument, spkiFingerprint } from "@aristotel/protocol";
import { ensureTlsKey, renewTlsCertificate } from "@aristotel/core";
import { registryDocument, signDocument } from "../../support/harness.ts";
import { callStation, prepareRelay, importRegistry, relayFetch, startNetwork, waitFor, type TestNetwork } from "../../support/network.ts";

const connected = (net: TestNetwork, i: number) => net.relays[i]!.server?.passages.hasControl("A") === true;
const journal = (net: TestNetwork, action: string) => net.server.db.prepare("SELECT actorId, details FROM journal WHERE action = ? ORDER BY seq").all(action);

test("1–3: Ретранслятор показывает отпечаток, принимает Реестр; Опорная станция входит на оба и держит соединения", async (t) => {
  const net = await startNetwork(t, { relays: 2 });
  for (const relay of net.relays) {
    assert.equal(spkiFingerprint(readFileSync(join(relay.dir, "tls-cert.pem"), "utf8")), relay.relay.tlsSpki);
    assert.equal(relay.server!.registry.number(), 1);
  }
  await waitFor(() => connected(net, 0) && connected(net, 1), 5000, "оба Прохода");
  // Ретранслятор видит управляющее соединение чуть раньше, чем Опорная станция отмечает связь.
  await waitFor(() => net.server.relays.states().every((s) => s.connected), 5000, "Опорная станция на связи с обоими");
  assert.deepEqual(net.server.relays.states().map((s) => s.connected), [true, true]);
  // RELAY-03: у Опорной станции слушает только API сопровождения на loopback, API Станций портов не слушает.
  const address = net.server.app.server.address() as AddressInfo;
  assert.match(address.address, /^(127\.0\.0\.1|::1)$/);
  assert.equal(net.server.stationApp.server.listening, false);
});

test("4: TLS-ключ Ретранслятора не тот, что в Реестре — соединения нет, журнал relay.tls-mismatch", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => connected(net, 0));
  const r = net.relays[0]!;
  await r.stop();
  rmSync(join(r.dir, "tls-key.pem"));
  rmSync(join(r.dir, "tls-cert.pem"));
  ensureTlsKey(r.dir);
  await r.start();
  await waitFor(() => journal(net, "relay.tls-mismatch").length > 0, 5000, "relay.tls-mismatch");
  assert.equal(connected(net, 0), false);
  const entry = journal(net, "relay.tls-mismatch")[0]!;
  assert.equal(entry["actorId"], null);
  assert.equal(JSON.parse(String(entry["details"])).relay, r.relay.url);
});

test("6: перевыпуск сертификата на том же ключе — соединение идёт без новой версии Реестра (RELAY-16)", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => connected(net, 0));
  const r = net.relays[0]!;
  await r.stop();
  renewTlsCertificate(r.dir);
  await r.start();
  await waitFor(() => connected(net, 0), 5000, "вход после перевыпуска");
  assert.equal(net.registryNumber(), 1);
});

test("7: у Опорной станции версия 3, у Ретранслятора 1 — Ретранслятор забирает новые версии (RELAY-17)", async (t) => {
  const net = await startNetwork(t, { relays: 1, startRelays: false });
  const r = net.relays[0]!;
  await net.publish([r.relay]);
  await net.publish([r.relay]);
  await r.start();
  await waitFor(() => r.server!.registry.number() === 3 && connected(net, 0), 5000, "версия 3 на Ретрансляторе");
});

test("8: у Ретранслятора версия 3, у Опорной станции 1 — станция применяет их сама, автор — служба (RELAY-18, NET-08)", async (t) => {
  const net = await startNetwork(t, { relays: 1, startRelays: false });
  const r = net.relays[0]!;
  await r.start();
  for (const number of [2, 3]) {
    const doc = signDocument(registryDocument(net.server.db, { number, relays: [r.relay], coordinatorKeys: [net.coordinatorKey.publicKey], issuedAt: `2026-10-18T11:00:0${number}.000Z` }), net.coordinatorKey);
    assert.equal((await relayFetch(r, "PUT", "/relay/v1/reestr", serializeSignedDocument(doc))).status, 200);
  }
  await r.stop();
  await r.start(); // Опорная станция входит заново и получает версии при входе
  await waitFor(() => net.registryNumber() === 3, 5000, "версия 3 у станции");
  const applied = net.server.db.prepare("SELECT appliedBy FROM registry_version WHERE number = 3").get();
  assert.equal(applied?.["appliedBy"], null);
  const last = journal(net, "registry.apply").at(-1)!;
  assert.equal(last["actorId"], null);
  assert.equal(JSON.parse(String(last["details"])).via, "relay");
});

test("9: развилка на Ретрансляторе — тревога своей Опорной станции, журнал relay.registry-conflict (RELAY-21)", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  const r = net.relays[0]!;
  await waitFor(() => connected(net, 0));
  for (const at of ["2026-10-18T12:00:00.000Z", "2026-10-18T12:00:01.000Z"]) {
    const doc = signDocument(registryDocument(net.server.db, { number: 2, relays: [r.relay], coordinatorKeys: [net.coordinatorKey.publicKey], issuedAt: at }), net.coordinatorKey);
    await relayFetch(r, "PUT", "/relay/v1/reestr", serializeSignedDocument(doc));
  }
  assert.equal(r.server!.registry.halted(), true);
  await r.stop();
  await r.start();
  await waitFor(() => journal(net, "relay.registry-conflict").length > 0, 5000, "relay.registry-conflict");
  const entry = JSON.parse(String(journal(net, "relay.registry-conflict")[0]!["details"]));
  assert.equal(entry.number, 2);
  assert.equal(entry.relay, r.relay.url);
});

test("10: R1 недоступен — Проход на R2 держится; R1 вернулся — вход заново (STATION-05)", async (t) => {
  const net = await startNetwork(t, { relays: 2 });
  await waitFor(() => connected(net, 0) && connected(net, 1));
  await net.relays[0]!.stop();
  await waitFor(() => net.server.relays.states()[0]?.connected === false, 5000, "R1 потерян");
  assert.equal(connected(net, 1), true);
  await net.relays[0]!.start();
  await waitFor(() => connected(net, 0), 5000, "R1 снова");
});

test("11: новая версия убрала R1 и добавила R3 — станция уходит с R1 и входит на R3", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => connected(net, 0));
  const r3 = await prepareRelay(t);
  await net.publish([r3.relay]);
  const v2 = net.server.db.prepare("SELECT document FROM registry_version WHERE number = 2").get();
  // Ретранслятор R3 ставит Группа и даёт ему версию, где он есть (RELAY-19).
  const doc = JSON.parse(String(v2?.["document"]));
  importRegistry(r3, doc);
  await r3.start();
  await waitFor(() => r3.server!.passages.hasControl("A"), 5000, "вход на R3");
  await waitFor(() => !connected(net, 0), 5000, "уход с R1");
  assert.deepEqual(net.server.relays.states().map((s) => s.url), [r3.relay.url]);
});

test("GET /api/registry: отпечаток TLS Опорной станции и связь Проходов (contracts/http-api.md, FR-019)", async (t) => {
  const net = await startNetwork(t, { relays: 2 });
  await waitFor(() => connected(net, 0) && connected(net, 1));
  // Ретранслятор видит управляющее соединение чуть раньше, чем Опорная станция отмечает связь.
  await waitFor(() => net.server.relays.states().every((s) => s.connected), 5000, "Опорная станция на связи с обоими");
  await net.relays[1]!.stop();
  await waitFor(() => net.server.relays.states()[1]?.connected === false, 5000, "Опорная станция видит: R2 недоступен");
  const res = await callStation(net, net.seniorId, "GET", "/api/registry");
  const body = res.json() as { baseTlsSpki: string; relays: { url: string; connected: boolean; since: string | null }[] };
  assert.equal(body.baseTlsSpki, net.server.tls.tlsSpki);
  assert.deepEqual(
    body.relays.map((r) => [r.url, r.connected]),
    [
      [net.relays[0]!.relay.url, true],
      [net.relays[1]!.relay.url, false],
    ],
  );
  assert.notEqual(body.relays[0]!.since, null);
});

