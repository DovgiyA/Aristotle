// Стенд сети на одной машине (T031 фичи 004, research R19): служба Опорной станции, Ретрансляторы на
// https://127.0.0.1:<порт> со своими каталогами данных и Реестр версии 1 с ними; ускоренные таймеры.
// Значения условные: Код A, ключи из семян.
import type { TestContext } from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { KeyObject } from "node:crypto";
import {
  REGISTRY_FORMAT,
  decodeBytes,
  deriveInvitationKeys,
  ed25519FromSeed,
  parseInvitation,
  publicKeyText,
  serializeSignedDocument,
  type Relay,
  type SignedDocument,
} from "@aristotel/protocol";
import {
  closeDatabase,
  ensureGroupKey,
  ensureTlsKey,
  openBank,
  pinnedTlsConnect,
  readAccessToken,
  startServer,
  writeInstall,
  type Server,
} from "@aristotel/core";
import { RelayRegistry, startRelay, type PassageTimers, type RelayServer } from "@aristotel/relay";
import { acceptInvitation, startLocalServer, type AcceptResult, type LocalServer } from "@aristotel/station";
import {
  addMember,
  freePort,
  openTestSession,
  presenceHeaderFor,
  type TestSession,
  insertCoordinatorKey,
  insertRegistryVersion,
  registerTestNote,
  registryDocument,
  removeAtExit,
  signDocument,
  testCoordinatorKey,
  type TestCoordinatorKey,
} from "./harness.ts";

export const FAST_RELAY_TIMERS = { ping: 200, silence: 1000, retryMin: 50, retryMax: 300, relogin: 60_000, journalEvery: 60_000 };
export const FAST_PASSAGE_TIMERS: Partial<PassageTimers> = { ping: 200, silence: 1000, spliceWait: 2000 };

/**
 * Временный каталог; before — что остановить после теста. Сам каталог удаляется в конце процесса
 * файла теста (removeAtExit): хуки t.after идут в порядке регистрации, а службы, которые держат файлы
 * каталога, тест часто регистрирует позже.
 */
export function tempDir(t: TestContext, prefix = "aristotel-net-", before?: () => Promise<void>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (before !== undefined) t.after(before);
  removeAtExit(dir);
  return dir;
}

export interface TestRelay {
  dir: string;
  port: number;
  relay: Relay;
  server: RelayServer | undefined;
  logs: string[];
  start: () => Promise<RelayServer>;
  stop: () => Promise<void>;
}

/** Каталог данных Ретранслятора с TLS-ключом; запускается позже, когда есть Реестр. */
export async function prepareRelay(t: TestContext, group = "A"): Promise<TestRelay> {
  let stop: () => Promise<void> = async () => {};
  const dir = tempDir(t, "aristotel-relay-", () => stop());
  const port = await freePort();
  const url = `https://127.0.0.1:${port}`;
  writeInstall(dir, { role: "relay", port, relay: { group, listen: `127.0.0.1:${port}`, url } });
  const tls = ensureTlsKey(dir);
  const logs: string[] = [];
  const relay: TestRelay = {
    dir,
    port,
    relay: { url, tlsSpki: tls.tlsSpki },
    server: undefined,
    logs,
    start: async () => {
      relay.server = await startRelay({ dataDir: dir, port, host: "127.0.0.1", timers: FAST_PASSAGE_TIMERS, logStream: { write: (line) => void logs.push(line) } });
      return relay.server;
    },
    stop: async () => {
      await relay.server?.close();
      relay.server = undefined;
    },
  };
  stop = relay.stop;
  return relay;
}

/** Первая версия Реестра на Ретранслятор — как relay registry import (RELAY-19). */
export function importRegistry(relay: TestRelay, doc: SignedDocument, group = "A"): void {
  new RelayRegistry(relay.dir, group, relay.relay.tlsSpki).importFirst(serializeSignedDocument(doc));
}

export interface TestNetwork {
  dir: string;
  server: Server;
  seniorId: string;
  coordinatorKey: TestCoordinatorKey;
  relays: TestRelay[];
  /** Строки лога службы Опорной станции за прогон (SC-004). */
  logs: string[];
  /** Применить следующую версию Реестра с такими Ретрансляторами через API сопровождения (NET-54). */
  publish: (relays: Relay[]) => Promise<SignedDocument>;
  registryNumber: () => number;
  close: () => Promise<void>;
}

/**
 * Сеть: Опорная станция A с Реестром версии 1, n Ретрансляторов в её записи, запущенных и знающих
 * Реестр. startRelays: false — Ретрансляторы не запущены (тест запускает сам).
 */
export async function startNetwork(
  t: TestContext,
  options: { relays?: number; startRelays?: boolean; extend?: Parameters<typeof startServer>[0]["extend"] } = {},
): Promise<TestNetwork> {
  registerTestNote();
  const relays: TestRelay[] = [];
  for (let i = 0; i < (options.relays ?? 1); i++) relays.push(await prepareRelay(t));
  let closeNetwork: () => Promise<void> = async () => {};
  const dir = tempDir(t, "aristotel-base-", () => closeNetwork());
  const install = writeInstall(dir, { role: "base-station", port: await freePort() });
  const coordinatorKey = testCoordinatorKey(0x41);
  const db = openBank(dir, install);
  const seniorId = addMember(db, "С1", "senior");
  await ensureGroupKey(dir, db);
  insertCoordinatorKey(db, seniorId, coordinatorKey.publicKey);
  const v1 = signDocument(registryDocument(db, { relays: relays.map((r) => r.relay), coordinatorKeys: [coordinatorKey.publicKey] }), coordinatorKey);
  insertRegistryVersion(db, v1, seniorId);
  closeDatabase(db);
  for (const relay of relays) {
    importRegistry(relay, v1);
    if (options.startRelays !== false) await relay.start();
  }
  const logs: string[] = [];
  const server = await startServer({
    dataDir: dir,
    relayTimers: FAST_RELAY_TIMERS,
    logStream: { write: (line) => void logs.push(line) },
    ...(options.extend === undefined ? {} : { extend: options.extend }),
  });
  const token = readAccessToken(dir);
  let number = 1;
  const network: TestNetwork = {
    dir,
    server,
    seniorId,
    coordinatorKey,
    relays,
    logs,
    publish: async (list) => {
      number = network.registryNumber() + 1;
      const doc = signDocument(registryDocument(server.db, { number, relays: list, coordinatorKeys: [coordinatorKey.publicKey] }), coordinatorKey);
      const res = await server.app.inject({
        method: "POST",
        url: "/api/registry/versions",
        headers: { "aristotel-api-version": "1", authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: serializeSignedDocument(doc),
      });
      if (res.statusCode !== 201) throw new Error(`публикация версии ${number}: ${res.statusCode} ${res.body}`);
      return doc;
    },
    registryNumber: () => Number(server.db.prepare("SELECT max(number) AS n FROM registry_version").get()?.["n"] ?? 0),
    close: async () => {
      await server.close();
    },
  };
  closeNetwork = network.close;
  return network;
}

/** Ждать условия не дольше timeoutMs. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000, label = "условие"): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`не дождались: ${label}`);
}

export interface RelayResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Запрос к Ретранслятору по TLS со сверкой отпечатка (так ходит Опорная станция). */
export async function relayFetch(
  relay: TestRelay,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<RelayResponse> {
  const socket = await pinnedTlsConnect({ host: "127.0.0.1", port: relay.port }, relay.relay.tlsSpki);
  return await new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const all: Record<string, string> = { host: "127.0.0.1", ...headers };
    if (text !== undefined) {
      all["content-type"] = "application/json";
      all["content-length"] = String(Buffer.byteLength(text));
    }
    const req = http.request({ method, path, headers: all, createConnection: () => socket }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
      res.on("end", () => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, body: data === "" ? {} : (JSON.parse(data) as Record<string, unknown>) });
      });
    });
    req.on("error", reject);
    req.end(text);
  });
}

/** Upgrade к Ретранслятору; удача — сокет, отказ — код ответа. */
export async function relayUpgrade(
  relay: TestRelay,
  path: string,
  protocol: string,
  headers: Record<string, string> = {},
): Promise<{ socket: Duplex } | { status: number }> {
  const socket = await pinnedTlsConnect({ host: "127.0.0.1", port: relay.port }, relay.relay.tlsSpki);
  return await new Promise((resolve, reject) => {
    const req = http.request({
      method: "GET",
      path,
      headers: { host: "127.0.0.1", connection: "Upgrade", upgrade: protocol, ...headers },
      createConnection: () => socket,
    });
    req.on("upgrade", (_res, upgraded, head) => {
      if (head.length > 0) upgraded.unshift(head);
      resolve({ socket: upgraded });
    });
    req.on("response", (res) => {
      res.resume();
      socket.destroy();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

// --- Реестр с ключом Группы под контролем теста (контрактные тесты Ретранслятора) ---


export const TEST_AGE_RECIPIENT = "age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj";

export interface TestGroup {
  code: string;
  key: KeyObject;
  signingKey: string;
}

export function testGroup(code: string, seedByte: number): TestGroup {
  const key = ed25519FromSeed(new Uint8Array(32).fill(seedByte));
  return { code, key, signingKey: publicKeyText(key) };
}

/** Версия Реестра: записи Групп с Ретрансляторами, Координирующая — первая, подпись signer. */
export function makeRegistry(
  number: number,
  groups: { group: TestGroup; relays: Relay[]; state?: "active" | "suspended" }[],
  coordinatorKeys: TestCoordinatorKey[],
  signer: TestCoordinatorKey,
  note = "",
): SignedDocument {
  const body = JSON.stringify({
    number,
    issuedAt: `2026-10-18T10:00:0${number % 10}.000Z`,
    coordinatingGroup: groups[0]!.group.code,
    coordinatorKeys: coordinatorKeys.map((k) => k.publicKey),
    groups: groups.map((g) => ({
      code: g.group.code,
      signingKey: g.group.signingKey,
      encryptionKey: TEST_AGE_RECIPIENT,
      state: g.state ?? "active",
      relays: note === "" ? g.relays : [...g.relays, { url: `https://${note}.test`, tlsSpki: g.relays[0]!.tlsSpki }],
    })),
  });
  return signDocument({ format: REGISTRY_FORMAT, body, signatures: [] }, signer);
}

// --- Станции на стенде (US2 фичи 004): Приглашение через API сопровождения и приём через Проход ---

/** Множитель scrypt файлов Ключей станций на стенде (research R19). */
export const TEST_WORK_FACTOR = 10;
export const TEST_STATION_PASSWORD = "test-password-x";

/** Приглашение Старшему по STATION-43 через API сопровождения службы стенда. */
export async function seniorInvitation(net: TestNetwork, memberId = net.seniorId): Promise<string> {
  const token = readAccessToken(net.dir);
  const res = await net.server.app.inject({
    method: "POST",
    url: "/api/invitations/senior",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: { memberId },
  });
  if (res.statusCode !== 201) throw new Error(`Приглашение: ${res.statusCode} ${res.body}`);
  const invitation = String(res.json().invitation);
  await invitationKnown(net, invitation);
  return invitation;
}

/**
 * Ключ Прохода свежего Приглашения дошёл до каждого работающего Ретранслятора. Перечень идёт
 * отдельным сообщением по управляющему соединению; без ожидания приём сразу после выпуска на
 * медленной машине получал отказ Ретранслятора (Linux Mint, 2026-10-18).
 */
export async function invitationKnown(net: TestNetwork, invitation: string): Promise<void> {
  const { passageKey } = deriveInvitationKeys(decodeBytes(parseInvitation(invitation).secret, 32)!);
  const live = net.relays.filter((r) => r.server?.passages.hasControl("A") === true);
  await waitFor(() => live.every((r) => r.server?.passages.listOf("A").some((e) => e.key === passageKey) === true), 5000, "ключ Приглашения у Ретрансляторов");
}

const stationSessions = new Map<string, TestSession>();

/** Запрос в API Станций службы стенда от имени Члена Группы — сеанс тестовой Станции, присутствие. */
export async function callStation(net: TestNetwork, memberId: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const key = `${net.dir} ${memberId}`;
  let session = stationSessions.get(key);
  if (session === undefined) stationSessions.set(key, (session = openTestSession(net.server.db, memberId)));
  const headers: Record<string, string> = {
    "aristotel-api-version": "1",
    authorization: `Bearer ${session.token}`,
    "aristotel-presence": presenceHeaderFor(session, method, url, payload),
  };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return await net.server.stationApp.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

/** Принять Станцию по Приглашению через настоящий Проход стенда. */
export async function acceptOnStand(t: TestContext, invitation: string, before?: () => Promise<void>): Promise<{ dir: string; result: AcceptResult }> {
  const dir = tempDir(t, "aristotel-station-", before);
  writeInstall(dir, { role: "station", port: await freePort() });
  const result = await acceptInvitation({ dataDir: dir, invitation, password: TEST_STATION_PASSWORD, workFactor: TEST_WORK_FACTOR });
  return { dir, result };
}

export interface TestStation {
  dir: string;
  result: AcceptResult;
  server: LocalServer;
  /** Строки лога локальной части (SC-004). */
  logs: string[];
  /** Запрос CLI к локальной части — с токеном локального доступа Станции. */
  local: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown>; text: string }>;
}

/**
 * Станция на стенде: Приглашение (Старшему — по STATION-43, иначе — от Старшего стенда), приём через
 * Проход, локальная часть на свободном порту, Ключ станции открыт, сеанс есть.
 */
export async function startStation(
  t: TestContext,
  net: TestNetwork,
  memberId = net.seniorId,
  options: { unlock?: boolean; clock?: () => number } = {},
): Promise<TestStation> {
  let server: LocalServer | undefined;
  const invitation =
    memberId === net.seniorId
      ? await seniorInvitation(net)
      : await (async () => {
          const issued = String((await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId })).json().invitation);
          await invitationKnown(net, issued);
          return issued;
        })();
  const { dir, result } = await acceptOnStand(t, invitation, async () => {
    await server?.close();
  });
  const logs: string[] = [];
  server = await startLocalServer({
    dataDir: dir,
    attemptMs: 2000,
    retryMs: 100,
    logStream: { write: (line) => void logs.push(line) },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  if (options.unlock !== false) {
    await server.part.unlock(TEST_STATION_PASSWORD);
    await waitFor(() => server!.part.session !== undefined, 10_000, "сеанс Станции");
  }
  const token = readAccessToken(dir);
  const local: TestStation["local"] = async (method, path, body, headers = {}) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, "aristotel-api-version": "1", ...headers } };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${server!.port}${path}`, init);
    const text = await res.text();
    return { status: res.status, text, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  return { dir, result, server, logs, local };
}

export interface UiClient {
  cookie: string;
  csrf: string;
  /** Запрос интерфейса: cookie, свой Origin и CSRF-токен на изменяющих запросах. */
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }>;
}

/** Токен запуска (как aristotel open) и сессия интерфейса в браузере (research R14). */
export async function uiLogin(station: TestStation): Promise<UiClient> {
  const { writeFileSync } = await import("node:fs");
  const launch = `launch-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(station.dir, "launch-token"), JSON.stringify({ token: launch, expiresAt: Date.now() + 120_000 }), { mode: 0o600 });
  const base = `http://127.0.0.1:${station.server.port}`;
  const res = await fetch(`${base}/local/ui-session`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ launchToken: launch }) });
  if (res.status !== 200) throw new Error(`ui-session: ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const { csrf } = (await res.json()) as { csrf: string };
  const call: UiClient["call"] = async (method, path, body, headers = {}) => {
    const all: Record<string, string> = { cookie, "aristotel-api-version": "1", ...headers };
    if (method !== "GET") {
      all["aristotel-csrf"] ??= csrf;
      all["origin"] ??= base;
    }
    const init: RequestInit = { method, headers: all };
    if (body !== undefined) {
      all["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`${base}${path}`, init);
    const text = await r.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      parsed = {};
    }
    return { status: r.status, body: parsed, text, headers: r.headers };
  };
  return { cookie, csrf, call };
}
