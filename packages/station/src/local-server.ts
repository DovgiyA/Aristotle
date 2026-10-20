// Сервер локальной части на 127.0.0.1 (APP-04, APP-06, APP-07, APP-27; contracts/lokalnaya-chast.md;
// research R13, R14 фичи 004): интерфейс — статическими файлами из поставки; защита — только loopback,
// проверка Host, сессия интерфейса по одноразовому токену запуска (cookie HttpOnly, SameSite=Strict),
// CSRF-токен и Origin на изменяющих запросах, блокировка по простою (STATION-11); CLI — по токену
// локального доступа; прокси /api/* к Опорной станции через сеанс; подтверждение присутствия и подпись
// черновика Ключом Координатора — паролем, который не покидает Станцию (STATION-09, STATION-12, NET-14).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PRESENCE_HEADER, message, type LocalState, type UiSessionResponse } from "@aristotel/protocol";
import { KeyFileError, TlsMismatchError, readAccessToken, readInstall } from "@aristotel/core";
import { LocalPart, StationDeletedError, StationLockedError, type LocalPartOptions } from "./local-part.ts";
import { fail } from "./http.ts";
import { presenceRoutes } from "./presence.ts";
import { LOCAL_SIGN_BODY_LIMIT, coordinatorSignRoute } from "./coordinator-sign.ts";
import { NoPassageError, UpdateRequiredError } from "./connection.ts";
import { AcceptError, acceptInvitation } from "./accept.ts";
import { isAccepted, readStationState, writeStationState } from "./station-files.ts";
import { DeliveryQueue } from "./materials/queue.ts";
import { materialLocalRoutes } from "./materials/routes.ts";

export const UI_COOKIE = "aristotel_session";
export const CSRF_HEADER = "aristotel-csrf";
export const LAUNCH_TOKEN_FILE = "launch-token";
export const LAUNCH_TOKEN_TTL_MS = 2 * 60 * 1000;
/** Не чаще раза в 30 с интерфейс сообщает о действиях человека (research R14). */
export const ACTIVITY_EVERY_MS = 30 * 1000;

export interface LocalServerOptions extends LocalPartOptions {
  /** Порт вместо install.json. */
  port?: number;
  logStream?: { write: (line: string) => void };
  /** Каталог собранного интерфейса; по умолчанию — packages/ui/dist рядом в монорепозитории. */
  uiDir?: string;
  /** Часы — стенд сдвигает время простоя. */
  clock?: () => number;
  /** Множитель scrypt Ключа станции при приёме из интерфейса (стенд — меньше 18). */
  workFactor?: number;
  /** Не дольше этого очередь Материалов ждёт отложенный Материал до новой проверки (стенд — меньше 60 с). */
  deliveryMaxWaitMs?: number;
}

export interface LocalServer {
  app: FastifyInstance;
  part: LocalPart;
  port: number;
  /** Очередь доставки файлов Материалов (фича 006). */
  deliveries: DeliveryQueue;
  close: () => Promise<void>;
}

interface UiSession {
  csrf: string;
  lastActivity: number;
}

const DEFAULT_UI_DIR = join(import.meta.dirname, "..", "..", "ui", "dist");

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export { fail } from "./http.ts";

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** Токен запуска интерфейса — файл каталога данных, одноразовый, 2 минуты (research R14). */
function takeLaunchToken(dataDir: string, given: string, now: number): boolean {
  const path = join(dataDir, LAUNCH_TOKEN_FILE);
  if (!existsSync(path)) return false;
  let stored: { token?: string; expiresAt?: number };
  try {
    stored = JSON.parse(readFileSync(path, "utf8")) as { token?: string; expiresAt?: number };
  } catch {
    return false;
  }
  if (typeof stored.token !== "string" || typeof stored.expiresAt !== "number" || stored.expiresAt < now || !sameToken(given, stored.token)) return false;
  rmSync(path, { force: true });
  return true;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Без удостоверения: страница и файлы интерфейса, обмен токена запуска на сессию. */
const PUBLIC_GET = /^\/(vhod)?$|^\/(index\.html|app\.js|app\.css)$/;

export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const install = readInstall(options.dataDir);
  if (install.role !== "station") throw new Error("role");
  const token = readAccessToken(options.dataDir);
  const clock = options.clock ?? Date.now;
  // Команда удаления выполнена — через секунду (интерфейс успеет увидеть 410) локальная часть
  // останавливается (STATION-22).
  const part = new LocalPart({
    ...options,
    onDeleted: () => {
      setTimeout(() => void app.close().finally(() => options.onDeleted?.()), 1000).unref();
    },
  });
  const uiSessions = new Map<string, UiSession>();
  const uiDir = options.uiDir ?? DEFAULT_UI_DIR;
  const port = options.port ?? install.port;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const idleLimit = () => (isAccepted(options.dataDir) ? readStationState(options.dataDir).idleLockMinutes : 15) * 60_000;

  const app = Fastify({
    forceCloseConnections: true,
    logger:
      options.logStream === undefined
        ? false
        : { stream: options.logStream, serializers: { req: (req) => ({ method: req.method, path: String(req.url).split("?")[0] }), res: (res) => ({ statusCode: res.statusCode }) } },
  });

  app.decorateRequest("uiSession", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Только loopback: соединение не с 127.0.0.1 закрывается без ответа (APP-06).
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      request.socket.destroy();
      return reply;
    }
    // 2. Host — ровно свой адрес: защита от DNS rebinding.
    if (!hosts.has(request.headers.host ?? "")) return fail(reply, "host_rejected");
    const path = request.url.split("?")[0] ?? request.url;
    if ((request.method === "GET" && PUBLIC_GET.test(path)) || (request.method === "POST" && path === "/local/ui-session")) return undefined;
    // 3. Удостоверение: CLI — токен локального доступа; интерфейс — cookie сессии.
    const auth = request.headers.authorization ?? "";
    if (auth.startsWith("Bearer ") && sameToken(auth.slice(7), token)) return undefined;
    const cookie = cookieValue(request, UI_COOKIE);
    const session = cookie === undefined ? undefined : uiSessions.get(cookie);
    if (session === undefined) return fail(reply, "ui_session_required");
    // 4. Изменяющий запрос интерфейса: CSRF-токен сессии и свой Origin.
    if (MUTATING.has(request.method)) {
      const csrf = request.headers[CSRF_HEADER];
      const origin = request.headers.origin;
      if (typeof csrf !== "string" || !sameToken(csrf, session.csrf) || origin === undefined || !hosts.has(origin.replace(/^http:\/\//, ""))) {
        return fail(reply, "csrf_rejected");
      }
    }
    // 5. Блокировка по простою — только интерфейс человека (STATION-11).
    const locked = part.unlocked && clock() - session.lastActivity > idleLimit();
    (request as unknown as { uiSession: UiSession }).uiSession = session;
    if (locked && !(path === "/local/state" || path === "/local/unlock")) return fail(reply, "ui_locked");
    return undefined;
  });

  const uiSessionOf = (request: FastifyRequest): UiSession | null => (request as unknown as { uiSession: UiSession | null }).uiSession;

  if (existsSync(uiDir)) {
    await app.register(fastifyStatic, { root: uiDir, serve: false });
    const index = async (_request: FastifyRequest, reply: FastifyReply) => reply.type("text/html; charset=utf-8").sendFile("index.html");
    app.get("/", index);
    app.get("/vhod", index);
    app.get("/index.html", index);
    app.get("/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").sendFile("app.js"));
    app.get("/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").sendFile("app.css"));
  }

  // Токен запуска → cookie сессии интерфейса и CSRF-токен (contracts/lokalnaya-chast.md «Вход в интерфейс»).
  app.post<{ Body: { launchToken?: unknown } }>("/local/ui-session", async (request, reply) => {
    const given = typeof request.body?.launchToken === "string" ? request.body.launchToken : "";
    if (!takeLaunchToken(options.dataDir, given, clock())) return fail(reply, "ui_session_required");
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    uiSessions.set(id, { csrf, lastActivity: clock() });
    reply.header("set-cookie", `${UI_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`);
    const response: UiSessionResponse = { csrf };
    return response;
  });

  app.get("/local/ui-session", async (request, reply) => {
    const session = uiSessionOf(request);
    if (session === null) return fail(reply, "ui_session_required");
    const response: UiSessionResponse = { csrf: session.csrf };
    return response;
  });

  app.get("/local/state", async (request) => {
    const session = uiSessionOf(request);
    const uiLocked = session !== null && part.unlocked && clock() - session.lastActivity > idleLimit();
    const state: LocalState = { ...part.state(), uiLocked };
    return state;
  });

  app.post("/local/activity", async (request, reply) => {
    const session = uiSessionOf(request);
    if (session !== null) session.lastActivity = clock();
    return reply.status(204).send();
  });

  // Пароль открывает Ключ станции; если он уже открыт — снимает блокировку интерфейса (STATION-09, STATION-11).
  app.post<{ Body: { password?: unknown } }>("/local/unlock", async (request, reply) => {
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    try {
      if (part.unlocked) await part.checkPassword(password);
      else await part.unlock(password);
    } catch (error) {
      if (error instanceof KeyFileError) return fail(reply, "password_wrong");
      throw error;
    }
    const session = uiSessionOf(request);
    if (session !== null) session.lastActivity = clock();
    const state: LocalState = { ...part.state(), uiLocked: false };
    return state;
  });

  // Приём по Приглашению с первого экрана интерфейса (STATION-16).
  app.post<{ Body: { invitation?: unknown; password?: unknown } }>("/local/accept", async (request, reply) => {
    const invitation = typeof request.body?.invitation === "string" ? request.body.invitation : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    try {
      await acceptInvitation({ dataDir: options.dataDir, invitation, password, ...(options.workFactor === undefined ? {} : { workFactor: options.workFactor }) });
      await part.unlock(password);
      return reply.status(201).send({ ...part.state(), uiLocked: false });
    } catch (error) {
      if (error instanceof AcceptError) {
        if (error.code === "password_weak") return fail(reply, "password_weak");
        return reply.status(error.status === 0 ? 422 : error.status).send({ error: error.code, message: message("accept_accept_failed") });
      }
      if (error instanceof TlsMismatchError) return reply.status(409).send({ error: "tls_mismatch", expected: error.expected, seen: error.seen, message: message("accept_accept_failed") });
      if (error instanceof NoPassageError) return fail(reply, "offline", { since: new Date(clock()).toISOString() });
      throw error;
    }
  });

  app.post<{ Body: { idleLockMinutes?: unknown } }>("/local/settings", async (request, reply) => {
    const minutes = request.body?.idleLockMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) return fail(reply, "invalid_request", { detail: "idleLockMinutes 1 … 120" });
    writeStationState(options.dataDir, { ...readStationState(options.dataDir), idleLockMinutes: minutes });
    return { idleLockMinutes: minutes };
  });

  // Подтверждение присутствия и подпись Ключом Координатора (STATION-12, NET-14).
  presenceRoutes(app, part);
  coordinatorSignRoute(app, part);

  // Материалы: регистрация, повторное Заверение, очередь доставки (фича 006). Очередь продолжает
  // недоставленное после перезапуска, как только откроют Ключ станции.
  const deliveries = new DeliveryQueue(part, {
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.deliveryMaxWaitMs === undefined ? {} : { maxWaitMs: options.deliveryMaxWaitMs }),
  });
  // Ключ открыт — подобрать потерянные копии с Записью (T079) и продолжить недоставленное.
  part.onUnlocked = () => deliveries.kick();
  // После каждого входа: связь вернулась или сеанс продлён — подобрать копии, чей ответ 201 потерян (T094).
  part.onSession = () => void deliveries.adopt().finally(() => deliveries.kick());
  materialLocalRoutes(app, part, deliveries);

  // Прокси к Опорной станции: ответы — без изменений (contracts/lokalnaya-chast.md «Банк — прокси»).
  // Предел тела — как у версии Словаря Сети (research R15 фичи 005); свои пределы маршрутов проверяет Опорная станция.
  app.all("/api/*", { bodyLimit: LOCAL_SIGN_BODY_LIMIT }, async (request, reply) => {
    const headers: Record<string, string> = {};
    const presence = request.headers[PRESENCE_HEADER];
    if (typeof presence === "string") headers[PRESENCE_HEADER] = presence;
    try {
      const res = await part.request(request.method, request.url, { ...(request.body === undefined ? {} : { body: request.body }), headers });
      reply.status(res.status);
      if (res.text === "") return reply.send();
      return reply.type("application/json; charset=utf-8").send(res.text);
    } catch (error) {
      if (error instanceof StationDeletedError) return fail(reply, "station_deleted");
      if (error instanceof StationLockedError) return fail(reply, "station_locked");
      if (error instanceof UpdateRequiredError) return fail(reply, "api_version_incompatible", { requested: "", supported: error.supported.join(", ") });
      if (error instanceof NoPassageError || (error as { code?: string }).code !== undefined) {
        return fail(reply, "offline", { since: part.state().offlineSince ?? "" });
      }
      throw error;
    }
  });

  await app.listen({ host: "127.0.0.1", port });
  const address = app.server.address();
  const actual = typeof address === "object" && address !== null ? address.port : port;
  if (actual !== port) {
    hosts.add(`127.0.0.1:${actual}`);
    hosts.add(`localhost:${actual}`);
  }
  return {
    app,
    part,
    port: actual,
    deliveries,
    close: async () => {
      await deliveries.stop();
      await part.stop();
      await app.close();
    },
  };
}
