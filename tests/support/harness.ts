// Тестовый стенд: служба во временном каталоге данных — в процессе (fastify.inject) и отдельным
// процессом. Служебный тип Записи test.note и Члены Группы заводятся здесь только для тестов
// (Clarifications spec.md фичи 001). Состав Группы через API — фича 002; стенд заводит Членов Группы
// прямо в БД, чтобы истории проверялись независимо друг от друга. Значения — условные.
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createPrivateKey, randomBytes, randomUUIDv7, sign as edSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import {
  API_VERSION_HEADER,
  PRESENCE_HEADER,
  REGISTRY_FORMAT,
  SESSION_TTL_MS,
  addSignature,
  bodySha256,
  ed25519FromSeed,
  ed25519Sign,
  encodeBytes,
  encodeKey,
  encodePresenceHeader,
  keyFingerprint,
  presenceBodyText,
  presenceMessage,
  publicKeyText,
  serializeSignedDocument,
  sha256Hex,
  spkiFingerprint,
  type Relay,
  type Role,
  type SessionScope,
  type SignedDocument,
} from "@aristotel/protocol";
import {
  PresenceVerifier,
  buildMaintenanceApp,
  buildStationApp,
  closeDatabase,
  ensureGroupKey,
  ensureTlsKey,
  openBank,
  readInstall,
  readAccessToken,
  registerRecordType,
  tokenHash,
  writeInstall,
  type App,
  type AppOptions,
  type Db,
  type Install,
} from "@aristotel/core";

const SERVICE_ENTRY = join(import.meta.dirname, "service-process.ts");

/** Служебный тип Записи — только в тестах; в поставке его нет (FR-004). */
export function registerTestNote(): void {
  registerRecordType({
    name: "test.note",
    fields: Type.Object({ x: Type.Optional(Type.String()) }, { additionalProperties: false }),
    indexText: (fields) => String(fields["x"] ?? ""),
  });
}

/** Завести Члена Группы прямо в БД — только в тестах. По умолчанию — Участник. */
export function addMember(db: Db, label: string, role: Role = "participant"): string {
  const id = randomUUIDv7();
  db.prepare(
    "INSERT INTO member (id, label, role, state, version, createdAt, bootstrap) VALUES (?, ?, ?, 'active', 1, ?, 0)",
  ).run(id, label, role, new Date().toISOString());
  return id;
}

/** Сменить роль прямо в БД — для тестов, которым не нужен состав через API (T012 фичи 002). */
export function setRole(db: Db, id: string, role: Role): void {
  db.prepare("UPDATE member SET role = ?, version = version + 1 WHERE id = ?").run(role, id);
}

/** Действующие лица сценариев в Группе A (scenarii-priemki.md, «Действующие лица»): c1 — С1, u1 — У1, n1 — Н1. */
export interface GroupA {
  c1: string;
  c2?: string;
  u1: string;
  u2: string;
  n1: string;
}

/**
 * Группа A поверх Старшего стенда С1: Участники У1 и У2, Наблюдатель Н1 и, если не сказано иначе,
 * второй Старший С2 (без него — для сценария 11, где Старший один).
 */
export function groupA(db: Db, seniorId: string, options: { withoutSecondSenior?: boolean } = {}): GroupA {
  const group: GroupA = {
    c1: seniorId,
    u1: addMember(db, "У1"),
    u2: addMember(db, "У2"),
    n1: addMember(db, "Н1", "observer"),
  };
  if (options.withoutSecondSenior !== true) group.c2 = addMember(db, "С2", "senior");
  return group;
}

const removeAtExitDirs = new Set<string>();

/**
 * Удалить каталог стенда в конце процесса файла теста — после всех хуков t.after, которые закрывают
 * службы и останавливают дочерние процессы. Хуки node:test идут в порядке регистрации, а каталог
 * создаётся раньше службы: на Windows удаление шло до закрытия bank.sqlite и падало с EPERM, а
 * следующий хук (остановка службы) уже не выполнялся. Повторы — на время, пока Windows отпускает
 * файлы только что остановленного процесса. Неудача видна: исключение при выходе роняет файл теста.
 */
export function removeAtExit(dir: string): void {
  if (removeAtExitDirs.size === 0) {
    process.on("exit", () => {
      for (const path of removeAtExitDirs) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
  }
  removeAtExitDirs.add(dir);
}

function tempDataDir(_t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-test-"));
  removeAtExit(dir);
  return dir;
}

// --- Сеанс тестовой Станции (T022 фичи 004, research R19): Станция и сеанс пишутся прямо в БД,
// запросы идут в API Станций с токеном сеанса и, где нужно, с подтверждением присутствия. ---

export interface TestSession {
  sessionId: string;
  stationId: string;
  memberId: string;
  token: string;
  /** Ключ станции тестовой Станции — им подписываются подтверждения присутствия. */
  key: KeyObject;
  publicKey: string;
}

let stationSeed = 0;

/** Станция и сеанс Члена Группы прямо в БД — только в тестах (Приглашение от CLI, issuedBy NULL). */
export function openTestSession(db: Db, memberId: string, options: { scope?: SessionScope; ttlMs?: number } = {}): TestSession {
  const seed = randomBytes(32);
  seed[0] = (stationSeed++ % 251) + 1;
  const key = ed25519FromSeed(seed);
  const publicKey = publicKeyText(key);
  const at = new Date();
  const invitationId = randomUUIDv7();
  db.prepare(
    "INSERT INTO invitation (id, memberId, issuedBy, issuedAt, expiresAt, passageKey, acceptKeyHash, state, usedAt) VALUES (?, ?, NULL, ?, ?, ?, 'test', 'used', ?)",
  ).run(invitationId, memberId, at.toISOString(), at.toISOString(), `test-${invitationId}`, at.toISOString());
  const stationId = randomUUIDv7();
  db.prepare(
    "INSERT INTO station (id, memberId, publicKey, keyFingerprint, invitationId, acceptedAt, state) VALUES (?, ?, ?, ?, ?, ?, 'active')",
  ).run(stationId, memberId, publicKey, keyFingerprint(publicKey), invitationId, at.toISOString());
  const token = randomBytes(32).toString("base64url");
  const sessionId = randomUUIDv7();
  db.prepare("INSERT INTO station_session (id, stationId, tokenHash, scope, startedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)").run(
    sessionId,
    stationId,
    tokenHash(token),
    options.scope ?? "full",
    at.toISOString(),
    new Date(at.getTime() + (options.ttlMs ?? SESSION_TTL_MS)).toISOString(),
  );
  return { sessionId, stationId, memberId, token, key, publicKey };
}

/** Заголовок Aristotel-Presence для запроса в сеансе тестовой Станции (STATION-12). */
export function presenceHeaderFor(session: TestSession, method: string, url: string, payload?: unknown): string {
  const path = url.split("?")[0] ?? url;
  let body: unknown = payload;
  if (typeof payload === "string") {
    try {
      body = payload === "" ? undefined : JSON.parse(payload);
    } catch {
      body = payload; // неразбираемое тело: присутствие такому запросу не поможет, отказ даст служба
    }
  }
  const nonce = new Uint8Array(randomBytes(16));
  const issuedAt = new Date().toISOString();
  const message = presenceMessage({ sessionId: session.sessionId, method, path, bodySha256: sha256Hex(presenceBodyText(body)), issuedAt, nonce });
  return encodePresenceHeader({ issuedAt, nonce: encodeBytes(nonce), signature: encodeBytes(ed25519Sign(session.key, message)) });
}

function sessionHeaders(token: string): Record<string, string> {
  return { [API_VERSION_HEADER]: "1", authorization: `Bearer ${token}` };
}

function maintenanceHeadersFor(token: string): Record<string, string> {
  return { [API_VERSION_HEADER]: "1", authorization: `Bearer ${token}` };
}

export interface TestService {
  /**
   * API Станций; inject сам добавляет подтверждение присутствия к запросам сеанса тестовой Станции,
   * если заголовка нет (rawInject — без этого).
   */
  app: App;
  rawInject: App["inject"];
  /** API сопровождения на loopback (APP-34). */
  maintenance: App;
  db: Db;
  dir: string;
  install: Install;
  /** Токен локального доступа — API сопровождения. */
  token: string;
  /** Член Группы стенда в роли Старшего (не первый Старший из init). */
  seniorId: string;
  /** Заголовки сеанса тестовой Станции Члена Группы (одна Станция на Члена Группы стенда). */
  authHeaders: (memberId: string) => Record<string, string>;
  /** Сеанс тестовой Станции Члена Группы. */
  session: (memberId: string) => TestSession;
  maintenanceHeaders: () => Record<string, string>;
  addMember: (label: string, role?: Role) => string;
  close: () => Promise<void>;
}

/** Служба в процессе теста: запросы через app.inject, без сети. */
export async function startTestService(
  t: TestContext,
  options: { logStream?: AppOptions["logStream"]; emptyGroup?: boolean } = {},
): Promise<TestService> {
  registerTestNote();
  const dir = tempDataDir(t);
  writeInstall(dir, { role: "base-station" });
  return await openTestService(t, dir, { ...options, seniorId: undefined });
}

interface OpenOptions {
  logStream?: AppOptions["logStream"];
  emptyGroup?: boolean;
  /** Член Группы стенда уже заведён (перезапуск, Банк прежней схемы). */
  seniorId: string | undefined;
}

/**
 * Открыть службу стенда в готовом каталоге данных — как startServer: Банк, Ключ Группы до приёма
 * запросов (T015 фичи 003), приложение. Закрывается после теста или при перезапуске.
 */
async function openTestService(t: TestContext, dir: string, options: OpenOptions): Promise<TestService> {
  const install = readInstall(dir);
  const db = openBank(dir, install);
  const token = readAccessToken(dir);
  // emptyGroup — состав Группы пуст, как до заведения первого Старшего (ROLE-26).
  const seniorId = options.seniorId ?? (options.emptyGroup === true ? "" : addMember(db, "С1", "senior"));
  const groupKey = await ensureGroupKey(dir, db);
  const tls = ensureTlsKey(dir);
  const appOptions: AppOptions = { db, install, token, groupKey, dataDir: dir, presence: new PresenceVerifier(), tlsSpki: () => tls.tlsSpki };
  if (options.logStream !== undefined) appOptions.logStream = options.logStream;
  const app = buildStationApp(appOptions);
  const maintenance = buildMaintenanceApp(appOptions);
  const sessions = new Map<string, TestSession>();
  const byToken = new Map<string, TestSession>();
  const session = (memberId: string): TestSession => {
    let found = sessions.get(memberId);
    if (found === undefined) {
      found = openTestSession(db, memberId);
      sessions.set(memberId, found);
      byToken.set(found.token, found);
    }
    return found;
  };
  const rawInject = app.inject.bind(app) as App["inject"];
  // Подтверждение присутствия — как его добавила бы локальная часть Станции (research R19).
  (app as { inject: unknown }).inject = (opts: Record<string, unknown>) => {
    const headers = { ...((opts["headers"] as Record<string, string> | undefined) ?? {}) };
    const auth = headers["authorization"] ?? "";
    const owner = byToken.get(auth.startsWith("Bearer ") ? auth.slice(7) : "");
    if (owner !== undefined && headers[PRESENCE_HEADER] === undefined) {
      headers[PRESENCE_HEADER] = presenceHeaderFor(owner, String(opts["method"] ?? "GET"), String(opts["url"]), opts["payload"]);
    }
    return rawInject({ ...opts, headers } as never);
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    await maintenance.close();
    closeDatabase(db);
  };
  t.after(close);
  return {
    app,
    rawInject,
    maintenance,
    db,
    dir,
    install,
    token,
    seniorId,
    authHeaders: (memberId) => sessionHeaders(session(memberId).token),
    session,
    maintenanceHeaders: () => maintenanceHeadersFor(token),
    addMember: (label, role) => addMember(db, label, role),
    close,
  };
}

/** Перезапуск службы стенда в том же каталоге данных: Банк и Ключ Группы открываются заново. */
export async function restartTestService(t: TestContext, svc: TestService): Promise<TestService> {
  await svc.close();
  return await openTestService(t, svc.dir, { seniorId: svc.seniorId });
}

/** Служба стенда в готовом каталоге данных (Банк прежней схемы) с уже заведённым Старшим. */
export async function startTestServiceIn(t: TestContext, dir: string, seniorId: string): Promise<TestService> {
  registerTestNote();
  return await openTestService(t, dir, { seniorId });
}

/** Запрос к API Станций стенда от имени Члена Группы — через сеанс его тестовой Станции. */
export async function callAs(svc: TestService, memberId: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const headers: Record<string, string> = { ...svc.authHeaders(memberId) };
  if (payload === undefined) return await svc.app.inject({ method, url, headers });
  headers["content-type"] = "application/json";
  return await svc.app.inject({ method, url, headers, payload: payload as Record<string, unknown> });
}

/** Запрос к API сопровождения стенда (APP-34). */
export async function callMaintenance(svc: TestService, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, memberId?: string) {
  const headers: Record<string, string> = { ...svc.maintenanceHeaders() };
  if (memberId !== undefined) headers["aristotel-member"] = memberId;
  if (payload === undefined) return await svc.maintenance.inject({ method, url, headers });
  headers["content-type"] = "application/json";
  return await svc.maintenance.inject({ method, url, headers, payload: payload as Record<string, unknown> });
}

/**
 * Число строк таблицы — для проверок «ничего не изменилось». В журнале — только записи Членов Группы:
 * запись службы group-key.create при запуске (фича 003) к действиям теста не относится.
 */
export function countRows(db: Db, table: "member" | "record" | "record_history" | "journal"): number {
  const where = table === "journal" ? " WHERE actorId IS NOT NULL" : "";
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get()?.["n"]);
}

/**
 * Свободный порт для службы стенда — вне эфемерных диапазонов ОС (Linux 32768–60999, macOS и Windows
 * 49152–65535): порт из них могло занять исходящее соединение параллельного теста раньше, чем служба
 * начнёт слушать (EADDRINUSE на Linux Mint, 2026-10-18).
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("нет свободного порта в 20000–31999");
}

export interface DataDir {
  dir: string;
  /** Порт API сопровождения (install.json). */
  port: number;
  /** Порт API Станций — только процесс стенда service-process.ts слушает его на loopback. */
  stationPort?: number;
  token: string;
  seniorId: string;
  /** Сеанс тестовой Станции Старшего стенда. */
  session?: TestSession;
}

/** Каталог данных Опорной станции с Банком и Членом Группы стенда, на свободных портах. */
export async function prepareDataDir(t: TestContext): Promise<DataDir> {
  const dir = tempDataDir(t);
  const install = writeInstall(dir, { role: "base-station", port: await freePort() });
  const db = openBank(dir, install);
  const seniorId = addMember(db, "С1", "senior");
  const session = openTestSession(db, seniorId, { ttlMs: 24 * 60 * 60 * 1000 });
  closeDatabase(db);
  return { dir, port: install.port, stationPort: await freePort(), token: readAccessToken(dir), seniorId, session };
}

export interface SpawnedService {
  child: ChildProcess;
  stop: () => Promise<void>;
}

/**
 * Служба отдельным процессом; ждёт, пока она начнёт отвечать. stationPort — процесс стенда слушает
 * API Станций на loopback, чтобы тесты ходили в него без Прохода (research R19).
 */
export async function spawnService(t: TestContext, target: string | DataDir): Promise<SpawnedService> {
  const dir = typeof target === "string" ? target : target.dir;
  const stationPort = typeof target === "string" ? undefined : target.stationPort;
  const args = stationPort === undefined ? [SERVICE_ENTRY, dir] : [SERVICE_ENTRY, dir, String(stationPort)];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`служба завершилась с кодом ${code}: ${stderr}`)));
  });
  return {
    child,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

const spawnedSessions = new Map<string, Map<string, TestSession>>();

/** Сеанс тестовой Станции Члена Группы в Банке работающего процесса стенда (WAL допускает второе соединение). */
function sessionInDataDir(data: DataDir, memberId: string): TestSession {
  if (memberId === data.seniorId && data.session !== undefined) return data.session;
  let byMember = spawnedSessions.get(data.dir);
  if (byMember === undefined) spawnedSessions.set(data.dir, (byMember = new Map()));
  let found = byMember.get(memberId);
  if (found === undefined) {
    const db = openBank(data.dir, readInstall(data.dir));
    try {
      found = openTestSession(db, memberId, { ttlMs: 24 * 60 * 60 * 1000 });
    } finally {
      closeDatabase(db);
    }
    byMember.set(memberId, found);
  }
  return found;
}

/** Запрос к API Станций процесса стенда по настоящему HTTP от имени Старшего стенда. */
export async function apiRequest(
  data: DataDir,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return await apiRequestAs(data, data.seniorId, method, path, body);
}

/** Запрос к API Станций процесса стенда от имени Члена Группы — через сеанс его тестовой Станции. */
export async function apiRequestAs(
  data: DataDir,
  memberId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (data.stationPort === undefined) throw new Error("у каталога стенда нет порта API Станций");
  const session = sessionInDataDir(data, memberId);
  const headers = sessionHeaders(session.token);
  headers[PRESENCE_HEADER] = presenceHeaderFor(session, method, path, body);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${data.stationPort}${path}`, init);
  return { status: res.status, body: await res.json() };
}

/** Запрос к API сопровождения процесса стенда (APP-34). */
export async function maintenanceRequest(data: DataDir, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const headers = maintenanceHeadersFor(data.token);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${data.port}${path}`, init);
  return { status: res.status, body: await res.json() };
}

export const CLI_ENTRY = join(import.meta.dirname, "..", "..", "packages", "cli", "src", "main.ts");

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Запустить CLI aristotel отдельным процессом и дождаться выхода. */
export function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Запустить CLI долгоживущим процессом (serve); ждёт строку на stdout. */
export async function spawnCli(t: TestContext, args: string[], ready: RegExp): Promise<SpawnedService> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (ready.test(stdout)) resolve();
    });
    child.once("exit", (code) => reject(new Error(`CLI завершился с кодом ${code}: ${stderr}`)));
  });
  return {
    child,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

/** Временный пустой каталог данных. */
export function emptyDataDir(t: TestContext): string {
  return tempDataDir(t);
}

// --- Сеть (фича 003, T015): Ключи Координатора, документы Реестра, Ретрансляторы ---

const VECTORS = join(import.meta.dirname, "..", "..", "packages", "protocol", "test", "vectors");

/** Тестовые Ретрансляторы: адреса *.test и отпечатки SPKI тестовых сертификатов (RELAY-16). */
export const RELAY_X: Relay = { url: "https://relay-x.test:8443", tlsSpki: spkiFingerprint(readFileSync(join(VECTORS, "relay-x.pem"), "utf8")) };
export const RELAY_Y: Relay = { url: "https://relay-y.test", tlsSpki: spkiFingerprint(readFileSync(join(VECTORS, "relay-y.pem"), "utf8")) };

export interface TestCoordinatorKey {
  publicKey: string;
  pkcs8: string;
  sign: (message: Uint8Array) => Uint8Array;
}

/** Ключ Координатора из детерминированного семени — без scrypt и без файла (research R14). */
export function testCoordinatorKey(seedByte: number): TestCoordinatorKey {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seedByte)]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const jwk = key.export({ format: "jwk" }) as { x: string };
  return {
    publicKey: encodeKey(Buffer.from(jwk.x, "base64url")),
    pkcs8: der.toString("base64"),
    sign: (message) => new Uint8Array(edSign(null, message, key)),
  };
}

/** Подписать документ тестовым ключом. */
export function signDocument(doc: SignedDocument, key: TestCoordinatorKey): SignedDocument {
  return addSignature(doc, key.publicKey, key.sign);
}

export interface RegistryBodyOptions {
  number?: number;
  code?: string;
  relays?: Relay[];
  coordinatorKeys: string[];
  issuedAt?: string;
  /** Правка тела перед сериализацией — для тестов отказов. */
  change?: (body: Record<string, unknown>, group: Record<string, unknown>) => void;
}

/** Неподписанный документ версии Реестра со своей записью по текущему Ключу Группы службы. */
export function registryDocument(db: Db, options: RegistryBodyOptions): SignedDocument {
  const key = db.prepare("SELECT signingKey, encryptionKey FROM group_key WHERE current = 1").get();
  if (key === undefined) throw new Error("у службы стенда нет Ключа Группы");
  const code = options.code ?? "A";
  const group: Record<string, unknown> = {
    code,
    signingKey: String(key["signingKey"]),
    encryptionKey: String(key["encryptionKey"]),
    state: "active",
    relays: options.relays ?? [RELAY_X],
  };
  const body: Record<string, unknown> = {
    number: options.number ?? 1,
    issuedAt: options.issuedAt ?? "2026-10-17T10:00:00.000Z",
    coordinatingGroup: code,
    coordinatorKeys: options.coordinatorKeys,
    groups: [group],
  };
  options.change?.(body, group);
  return { format: REGISTRY_FORMAT, body: JSON.stringify(body), signatures: [] };
}

/** Применённая версия прямо в БД — для тестов, которым не нужна US3 (T015). */
export function insertRegistryVersion(db: Db, doc: SignedDocument, appliedBy: string): void {
  const number = Number((JSON.parse(doc.body) as { number: number }).number);
  db.prepare(
    "INSERT INTO registry_version (number, document, bodySha256, signedBy, appliedAt, appliedBy) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(number, serializeSignedDocument(doc), bodySha256(doc.body), doc.signatures[0]?.key ?? "", new Date().toISOString(), appliedBy);
}

/** Зарегистрировать Ключ Координатора за Членом Группы прямо в БД — для тестов без US2. */
export function insertCoordinatorKey(db: Db, memberId: string, publicKey: string): void {
  db.prepare(
    "INSERT INTO coordinator_key (id, publicKey, keyFingerprint, memberId, state, registeredAt) VALUES (?, ?, ?, ?, 'registered', ?)",
  ).run(randomUUIDv7(), publicKey, keyFingerprint(publicKey), memberId, new Date().toISOString());
}

/** Запустить Сеть стенда: Ключ Координатора Старшего и Реестр версии 1 с Ретрансляторами (фича 003). */
export function launchTestNetwork(svc: TestService, relays: Relay[] = [RELAY_X], seed = 0x11): TestCoordinatorKey {
  const key = testCoordinatorKey(seed);
  insertCoordinatorKey(svc.db, svc.seniorId, key.publicKey);
  insertRegistryVersion(svc.db, signDocument(registryDocument(svc.db, { relays, coordinatorKeys: [key.publicKey] }), key), svc.seniorId);
  return key;
}

/** Пароль тестовых файлов Ключа Координатора. */
export const TEST_KEY_PASSWORD = "test-password-x";

/**
 * Файл Ключа Координатора, как у CLI, но со scrypt множителем 10 (research R14): через модуль
 * key-file.ts, вне каталога данных dataDir. Возвращает открытый ключ.
 */
export async function writeCoordinatorKeyFile(path: string, dataDir: string, password = TEST_KEY_PASSWORD): Promise<string> {
  const { createKeyFile } = await import("../../packages/cli/src/key-file.ts");
  return (await createKeyFile(path, password, { dataDir, workFactor: 10 })).publicKey;
}

/** Файл пароля для --password-file. */
export function writePasswordFile(path: string, password = TEST_KEY_PASSWORD): string {
  writeFileSync(path, `${password}\n`, { mode: 0o600 });
  return path;
}
