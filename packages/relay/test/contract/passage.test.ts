// T025 фичи 004 — контракт contracts/prohod-v1.md: управляющее соединение, перечень Прохода, вызов и
// склейка соединения Станции с соединением Опорной станции без разбора потоков; отказы (STATION-02,
// STATION-04, STATION-17, STATION-41; research R5).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Duplex } from "node:stream";
import {
  PASSAGE_CHALLENGE_HEADER,
  PASSAGE_KEY_HEADER,
  PASSAGE_SIGNATURE_HEADER,
  UPGRADE_CONTROL,
  UPGRADE_PASSAGE,
  decodeBytes,
  ed25519FromSeed,
  ed25519Sign,
  encodeBytes,
  passageMessage,
  publicKeyText,
  relayLoginMessage,
  type PassageKeyEntry,
} from "@aristotel/protocol";
import type { KeyObject } from "node:crypto";
import { testCoordinatorKey } from "../../../../tests/support/harness.ts";
import { importRegistry, makeRegistry, prepareRelay, relayFetch, relayUpgrade, testGroup, waitFor, type TestRelay } from "../../../../tests/support/network.ts";

const K1 = testCoordinatorKey(0x71);
const A = testGroup("A", 0x72);
const stationKey = ed25519FromSeed(new Uint8Array(32).fill(0x73));
const STATION = publicKeyText(stationKey);

async function relayForA(t: Parameters<typeof prepareRelay>[0]): Promise<TestRelay> {
  const relay = await prepareRelay(t);
  importRegistry(relay, makeRegistry(1, [{ group: A, relays: [relay.relay] }], [K1], K1));
  await relay.start();
  return relay;
}

async function token(relay: TestRelay): Promise<string> {
  const c = String((await relayFetch(relay, "POST", "/relay/v1/vhod/vyzov")).body["challenge"]);
  const signature = encodeBytes(ed25519Sign(A.key, relayLoginMessage("A", decodeBytes(c, 32)!, decodeBytes(relay.relay.tlsSpki, 32)!)));
  const res = await relayFetch(relay, "POST", "/relay/v1/vhod", { code: "A", registryNumber: 1, challenge: c, signature });
  return String(res.body["token"]);
}

interface Control {
  socket: Duplex;
  lines: Record<string, unknown>[];
  send: (message: unknown) => void;
}

async function control(relay: TestRelay, tok: string): Promise<Control> {
  const res = await relayUpgrade(relay, "/relay/v1/prohod/A/upravlenie", UPGRADE_CONTROL, { authorization: `Bearer ${tok}` });
  if (!("socket" in res)) throw new Error(`управляющее соединение: ${res.status}`);
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  res.socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let i = buffer.indexOf("\n");
    while (i !== -1) {
      lines.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
      i = buffer.indexOf("\n");
    }
  });
  return { socket: res.socket, lines, send: (m) => res.socket.write(`${JSON.stringify(m)}\n`) };
}

async function stationConnect(relay: TestRelay, key: KeyObject = stationKey, signer: KeyObject = key) {
  const c = String((await relayFetch(relay, "POST", "/relay/v1/prohod/A/vyzov")).body["challenge"]);
  const signature = encodeBytes(ed25519Sign(signer, passageMessage("A", decodeBytes(c, 32)!)));
  return relayUpgrade(relay, "/relay/v1/prohod/A/soedinenie", UPGRADE_PASSAGE, {
    [PASSAGE_KEY_HEADER]: publicKeyText(key),
    [PASSAGE_CHALLENGE_HEADER]: c,
    [PASSAGE_SIGNATURE_HEADER]: signature,
  });
}

const list = (entries: PassageKeyEntry[]) => ({ type: "passage-list", keys: entries });

test("управляющее соединение — только с токеном своей Группы; второе закрывает первое", async (t) => {
  const relay = await relayForA(t);
  const bad = await relayUpgrade(relay, "/relay/v1/prohod/A/upravlenie", UPGRADE_CONTROL, { authorization: "Bearer x" });
  assert.deepEqual(bad, { status: 401 });
  const tok = await token(relay);
  const first = await control(relay, tok);
  const closed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
  await control(relay, tok);
  await closed;
  assert.ok(relay.server!.passages.hasControl("A"));
});

test("склейка: ключ из перечня и верная подпись — вызов, приём, байты в обе стороны как есть", async (t) => {
  const relay = await relayForA(t);
  const tok = await token(relay);
  const ctl = await control(relay, tok);
  ctl.send(list([{ key: STATION, kind: "station", state: "active" }]));
  await waitFor(() => relay.server!.passages.listOf("A").length === 1);
  const connecting = stationConnect(relay);
  await waitFor(() => ctl.lines.some((l) => l["type"] === "call"), 3000, "call");
  const callId = String(ctl.lines.find((l) => l["type"] === "call")!["callId"]);
  const base = await relayUpgrade(relay, `/relay/v1/prohod/A/priem/${callId}`, UPGRADE_PASSAGE, { authorization: `Bearer ${tok}` });
  const station = await connecting;
  assert.ok("socket" in base && "socket" in station);
  const bytes = Buffer.from([0x16, 0x03, 0x01, 0x00, 0xff, 0x00]);
  const got = new Promise<Buffer>((resolve) => base.socket.once("data", (d: Buffer) => resolve(d)));
  station.socket.write(bytes);
  assert.deepEqual(await got, bytes);
  const back = new Promise<Buffer>((resolve) => station.socket.once("data", (d: Buffer) => resolve(d)));
  base.socket.write("ответ");
  assert.equal(String(await back), "ответ");
  // Ключ ушёл из перечня — склейка закрыта (STATION-17).
  const closed = new Promise<void>((resolve) => station.socket.once("close", () => resolve()));
  ctl.send(list([]));
  await closed;
});

test("отказы Прохода — 403: ключ не из перечня, чужая подпись, просроченный вызов; без управляющего соединения", async (t) => {
  const relay = await relayForA(t);
  assert.deepEqual(await stationConnect(relay), { status: 403 }, "нет управляющего соединения");
  const ctl = await control(relay, await token(relay));
  ctl.send(list([{ key: STATION, kind: "station", state: "active" }, { key: publicKeyText(ed25519FromSeed(new Uint8Array(32).fill(0x74))), kind: "invitation", expiresAt: "2000-01-01T00:00:00.000Z" }]));
  await waitFor(() => relay.server!.passages.listOf("A").length === 2);
  assert.deepEqual(await stationConnect(relay, ed25519FromSeed(new Uint8Array(32).fill(0x75))), { status: 403 }, "ключ не из перечня");
  assert.deepEqual(await stationConnect(relay, stationKey, ed25519FromSeed(new Uint8Array(32).fill(0x76))), { status: 403 }, "подпись не этим ключом");
  assert.deepEqual(await stationConnect(relay, ed25519FromSeed(new Uint8Array(32).fill(0x74))), { status: 403 }, "Приглашение истекло");
  const reused = String((await relayFetch(relay, "POST", "/relay/v1/prohod/A/vyzov")).body["challenge"]);
  const sig = encodeBytes(ed25519Sign(stationKey, passageMessage("A", decodeBytes(reused, 32)!)));
  const headers = { [PASSAGE_KEY_HEADER]: STATION, [PASSAGE_CHALLENGE_HEADER]: reused, [PASSAGE_SIGNATURE_HEADER]: sig };
  // Первое соединение ждёт приёма и закроется по таймеру — его исход здесь не важен.
  const first = relayUpgrade(relay, "/relay/v1/prohod/A/soedinenie", UPGRADE_PASSAGE, headers).catch(() => undefined);
  assert.deepEqual(await relayUpgrade(relay, "/relay/v1/prohod/A/soedinenie", UPGRADE_PASSAGE, headers), { status: 403 }, "вызов потрачен");
  await first;
});

test("нет приёма за отведённое время — сокет Станции закрыт; чужой callId — 403", async (t) => {
  const relay = await relayForA(t);
  const tok = await token(relay);
  const ctl = await control(relay, tok);
  ctl.send(list([{ key: STATION, kind: "station", state: "delete-only" }]));
  await waitFor(() => relay.server!.passages.listOf("A").length === 1);
  assert.deepEqual(await relayUpgrade(relay, "/relay/v1/prohod/A/priem/unknown", UPGRADE_PASSAGE, { authorization: `Bearer ${tok}` }), { status: 403 });
  const station = stationConnect(relay);
  await waitFor(() => ctl.lines.some((l) => l["type"] === "call"), 3000, "call");
  // Сокет Станции ждёт 101; без приёма за 2 с (ускоренный таймер стенда) Ретранслятор его закрывает.
  await assert.rejects(station);
});

test("ping — pong; тишина дольше предела — разрыв управляющего соединения", async (t) => {
  const relay = await relayForA(t);
  const ctl = await control(relay, await token(relay));
  ctl.send({ type: "ping" });
  await waitFor(() => ctl.lines.some((l) => l["type"] === "pong"), 2000, "pong");
  await waitFor(() => ctl.lines.some((l) => l["type"] === "ping"), 2000, "ping от Ретранслятора");
  const closed = new Promise<void>((resolve) => ctl.socket.once("close", () => resolve()));
  await closed; // ускоренная тишина — 1 с без ответа
  await waitFor(() => !relay.server!.passages.hasControl("A"), 2000, "управляющее соединение закрыто");
});
