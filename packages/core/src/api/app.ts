// Каркас JSON API службы Опорной станции — два входа в одно ядро (APP-34; research R9 фичи 004):
// API Станций — автор из сеанса Станции, подтверждение присутствия для действий с признаком
// (STATION-10, STATION-12, ROLE-09); API сопровождения на loopback — токен локального доступа и только
// маршруты с пометкой maintenance. Общее: версия API, право автора на действие маршрута, единый вид
// ошибок, логи без данных дел (APP-23, FR-005; research R10, R11, R14 фичи 001; R1, R6 фичи 002).
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { timingSafeEqual } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import {
  API_VERSIONS,
  API_VERSION_HEADER,
  MEMBER_HEADER,
  PRESENCE_HEADER,
  describeIssues,
  isAction,
  isSupportedApiVersion,
  message,
  needsPresence,
  type Action,
  type IssueScope,
  type Role,
  type SchemaIssue,
  type RelayLink,
} from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import type { Install } from "../install/install.ts";
import { ApiError, isStorageUnavailable } from "./errors.ts";
import { assertActor } from "../rights/rights.ts";
import { versionRoutes } from "./routes/version.ts";
import { memberRoutes } from "./routes/members.ts";
import { recordRoutes } from "./routes/records.ts";
import { journalRoutes } from "./routes/journal.ts";
import { networkRoutes } from "./routes/network.ts";
import { dictionaryRoutes } from "./routes/dictionary.ts";
import { caseRoutes } from "./routes/cases.ts";
import { formRoutes } from "./routes/form.ts";
import { localExtensionRoutes } from "./routes/local-extension.ts";
import { materialRoutes } from "./routes/materials.ts";
import { registerLocalStopListStep } from "../local-extension/proposals.ts";
import { registerFormSummary } from "../model/form.ts";
import { registerModelTypes } from "../model/types.ts";
import { registerMaterialType } from "../materials/type.ts";
import { statusRoutes } from "./routes/status.ts";
import { stationRoutes } from "./routes/stations.ts";
import { sessionRoutes } from "./routes/session.ts";
import { ownPassages } from "../stations/invitations.ts";
import type { GroupKeyHandle } from "../network/group-key.ts";
import { createJournalCursor } from "../bank/journal-cursor.ts";
import {
  SessionChallenges,
  StationConnections,
  authenticateSession,
  sessionContext,
  type SessionStore,
  type StationSession,
  type TrackedSocket,
} from "../stations/sessions.ts";
import { networkEvents } from "../network/events.ts";
import { PresenceVerifier } from "../stations/presence.ts";

/** Через какой вход пришёл запрос (research R9 фичи 004). */
export type ApiKind = "station" | "maintenance";

declare module "fastify" {
  interface FastifyRequest {
    /** Идентификатор Члена Группы — автора действия; пустая строка — автора нет (сопровождение). */
    memberId: string;
    /** Роль автора на момент запроса — читается из БД на каждом запросе (research R1 фичи 002). */
    memberRole: Role;
    /** Сеанс Станции — на API Станций, кроме маршрутов без сеанса. */
    session: StationSession | null;
    via: ApiKind;
  }
  interface FastifyContextConfig {
    /** Маршрут без заголовков версии, токена и автора (только GET /api/version). */
    public?: boolean;
    /** Маршрут без автора (заведение первого Старшего, ROLE-26). */
    noMember?: boolean;
    /** API Станций: маршрут без сеанса — приём Станции и вход (STATION-10, STATION-16). */
    noSession?: boolean;
    /** API Станций: нужен сеанс, но не право из таблицы — события, команда удаления, конец сеанса. */
    sessionOnly?: boolean;
    /** API Станций: маршрут доступен сеансу «только удаление» (STATION-22). */
    deleteOnly?: boolean;
    /** API сопровождения: true — маршрут есть; "member" — с автором из Aristotel-Member (APP-34). */
    maintenance?: boolean | "member";
    /** Только API сопровождения (первый Старший, Приглашение по STATION-43, состояние станции). */
    onlyMaintenance?: boolean;
    /** Вид действия маршрута в таблице прав (FR-005). */
    right?: Action;
  }
}

/** Контекст маршрутов фичи 004, который подключают US1 … US5 (Станции, Приглашения, Проходы). */
export interface StationsContext {
  register: (app: FastifyInstance, kind: ApiKind) => void;
}

export interface AppOptions {
  db: Db;
  install: Install;
  /** Каталог данных Опорной станции — дерево Материалов (фича 006). */
  dataDir?: string;
  /** Токен локального доступа — только API сопровождения. */
  token: string;
  /** Ключ Группы службы (фича 003): открытые части, подпись, признак «недоступен» (NET-53). */
  groupKey: GroupKeyHandle;
  /** Куда писать логи; без него логи выключены. */
  logStream?: { write: (line: string) => void };
  /** Проверка подтверждений присутствия — одна на процесс службы (research R10 фичи 004). */
  presence?: PresenceVerifier;
  /** Маршруты фичи 004 поверх маршрутов Банка. */
  stations?: StationsContext;
  /** Отпечаток TLS Опорной станции и состояние Проходов — для GET /api/status. */
  tlsSpki?: () => string;
  relays?: () => RelayLink[];
  /** Вызовы входа Станций — одни на процесс службы. */
  sessionChallenges?: SessionChallenges;
  /** Долгий запрос событий Станции, мс (по умолчанию 30 с). */
  eventsWaitMs?: number;
  /** Соединения Станций — рвутся при отзыве (STATION-17). */
  connections?: StationConnections;
}

export type App = FastifyInstance;

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Путь без параметров запроса: параметры могут нести значения полей (research R14 фичи 001). */
export function pathOf(request: FastifyRequest): string {
  return request.url.split("?")[0] ?? request.url;
}

function bearer(request: FastifyRequest): string {
  const auth = request.headers.authorization ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function checkApiVersion(request: FastifyRequest): void {
  const requested = header(request, API_VERSION_HEADER);
  if (!isSupportedApiVersion(requested)) {
    throw new ApiError(
      "api_version_incompatible",
      { requested: requested ?? message("value_not_given_version"), supported: API_VERSIONS.join(", ") },
      { supported: [...API_VERSIONS] },
    );
  }
}

function createBase(options: AppOptions, kind: ApiKind): App {
  const app = Fastify({
    logger:
      options.logStream === undefined
        ? false
        : {
            stream: options.logStream,
            serializers: {
              req: (req) => ({ method: req.method, path: String(req.url).split("?")[0] }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorateRequest("memberId", "");
  app.decorateRequest("memberRole", "observer");
  app.decorateRequest("session", null);
  app.decorateRequest("via", kind);

  // Маршрут без права из таблицы — ошибка запуска: правило прав одно на все действия (research R1 фичи 002).
  app.addHook("onRoute", (route) => {
    const config = (route.config ?? {}) as Record<string, unknown>;
    if (config["public"] === true || config["noMember"] === true || config["noSession"] === true || config["sessionOnly"] === true) return;
    if (!isAction(config["right"])) {
      const method = Array.isArray(route.method) ? route.method.join(",") : route.method;
      throw new Error(message("route_without_right", { method, path: route.url }));
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) return reply.status(error.status).send(error.body());
    // Ошибки Fastify и AJV — клиентские; людям — русское описание, не текст библиотеки.
    const fastify = error as { validation?: SchemaIssue[]; validationContext?: string; code?: string; statusCode?: number };
    if (fastify.validation !== undefined) {
      const scope = (fastify.validationContext ?? "body") as IssueScope;
      const failure = new ApiError("invalid_request", { detail: describeIssues(fastify.validation, scope) });
      return reply.status(failure.status).send(failure.body());
    }
    if (typeof fastify.code === "string" && fastify.code.startsWith("FST_ERR_CTP_")) {
      // Слишком большой запрос — так и сказано, а не «некорректный JSON» (T261).
      const detail = message(
        fastify.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? "detail_media_type" : fastify.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? "detail_body_too_large" : "detail_body_json",
      );
      const failure = new ApiError("invalid_request", { detail });
      return reply.status(failure.status).send(failure.body());
    }
    if (typeof fastify.statusCode === "number" && fastify.statusCode >= 400 && fastify.statusCode < 500) {
      const failure = new ApiError("invalid_request", { detail: message("detail_request_unreadable") });
      return reply.status(failure.status).send(failure.body());
    }
    if (isStorageUnavailable(error)) {
      const failure = new ApiError("storage_unavailable");
      return reply.status(failure.status).send(failure.body());
    }
    request.log.error({ err: { type: (error as Error).name } }, message("log_internal_error"));
    const failure = new ApiError("internal_error");
    return reply.status(failure.status).send(failure.body());
  });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.status(404).send({ error: "not_found", message: message("route_not_found", { path: pathOf(request) }) });
  });
  return app;
}

function registerRoutes(app: App, options: AppOptions, kind: ApiKind): void {
  const { db, install } = options;
  versionRoutes(app, install);
  memberRoutes(app, db);
  recordRoutes(app, db);
  // Ключ курсоров журнала живёт, пока живёт процесс службы (VIEW-59, research R3 фичи 002).
  journalRoutes(app, db, createJournalCursor());
  const tlsSpki = options.tlsSpki ?? (() => "");
  networkRoutes(app, { db, install, groupKey: options.groupKey, tlsSpki, relays: options.relays ?? (() => []) });
  dictionaryRoutes(app, db);
  // Типы Записей модели данных (фича 005) — до приёма запросов.
  registerModelTypes();
  // Запись о Материале (фича 006).
  registerMaterialType();
  registerFormSummary();
  registerLocalStopListStep();
  caseRoutes(app, db);
  formRoutes(app, db);
  localExtensionRoutes(app, db);
  materialRoutes(app, db, options.dataDir);
  statusRoutes(app, { db, groupKey: options.groupKey, tlsSpki, relays: options.relays ?? (() => []) });
  const invitations = { db, installId: install.installId, groupKey: options.groupKey, tlsSpki };
  stationRoutes(app, invitations);
  sessionRoutes(app, {
    db,
    challenges: options.sessionChallenges ?? new SessionChallenges(),
    passages: () => ownPassages(invitations)?.passages ?? [],
    eventsWaitMs: options.eventsWaitMs ?? 30_000,
  });
  options.stations?.register(app, kind);
}

/**
 * API Станций (research R9 фичи 004): портов не слушает — соединения приходят из Проходов внутри TLS.
 * Автор — Член Группы, за которым закреплена Станция сеанса; заголовок Aristotel-Member — 400.
 */
export function buildStationApp(options: AppOptions): App {
  const { db } = options;
  const presence = options.presence ?? new PresenceVerifier();
  const connections = options.connections ?? new StationConnections();
  const app = createBase(options, "station");

  // Сеанс запроса — в контексте до конца обработки: ядро перепроверяет его в транзакции (STATION-17).
  // Разбор тела идёт в контексте сокета, поэтому после него контекст восстанавливается.
  const scopes = new WeakMap<FastifyRequest, { store: SessionStore; resource: AsyncResource }>();
  app.addHook("onRequest", (request, _reply, done) => {
    const socket = request.raw.socket as unknown as Partial<TrackedSocket> | null;
    const real = typeof socket?.once === "function" && typeof socket.destroy === "function";
    const store: SessionStore = { session: null, socket: real ? (socket as TrackedSocket) : null };
    sessionContext.run(store, () => {
      scopes.set(request, { store, resource: new AsyncResource("aristotel-request") });
      done();
    });
  });
  app.addHook("preValidation", (request, _reply, done) => {
    const scope = scopes.get(request);
    if (scope === undefined) return done();
    scope.resource.runInAsyncScope(done, null);
  });

  // Отзыв зафиксирован — рвём соединения Станций сразу (SC-002 фичи 004).
  const onRevoked = (stationIds: string[]): void => {
    const store = sessionContext.getStore();
    const later =
      store?.socket === null || store === undefined
        ? undefined
        : { socket: store.socket, after: (close: () => void) => setTimeout(close, 50).unref() };
    for (const id of stationIds) connections.close(id, later);
  };
  networkEvents.on("stations-revoked", onRevoked);
  app.addHook("onClose", async () => {
    networkEvents.off("stations-revoked", onRevoked);
  });

  app.addHook("onRequest", async (request) => {
    // Доступ решается по найденному маршруту, а не по сырому URL (ревью фичи 001, P1).
    if (request.routeOptions.url === undefined) return;
    const config = request.routeOptions.config;
    if (config.public === true) return;
    checkApiVersion(request);
    if (header(request, MEMBER_HEADER) !== undefined) {
      throw new ApiError("invalid_request", { detail: message("detail_member_header") });
    }
    if (config.onlyMaintenance === true) throw new ApiError("not_found", { path: pathOf(request) }, {}, "route_not_found");
    if (config.noSession === true) return;
    const session = authenticateSession(db, bearer(request));
    const scope = scopes.get(request);
    if (scope !== undefined) {
      scope.store.session = session;
      if (scope.store.socket !== null) connections.track(session.stationId, scope.store.socket);
    }
    if (session.scope === "delete-only" && config.deleteOnly !== true) throw new ApiError("station_delete_only");
    request.session = session;
    request.memberId = session.memberId;
    if (config.sessionOnly === true) return;
    // Отзыв и смена роли действуют сразу: состояние и роль — из БД на каждом запросе (ROLE-09, STATION-17).
    // Право — до разбора тела и поиска предмета: отказ не говорит, есть ли предмет (FR-008 фичи 002).
    const right = config.right as Action;
    request.memberRole = assertActor(db, session.memberId, right);
    if (needsPresence(right) && header(request, PRESENCE_HEADER) === undefined) throw new ApiError("presence_required");
  });

  // Подпись присутствия покрывает тело — проверяется после разбора, до обработчика (STATION-12).
  app.addHook("preValidation", async (request) => {
    const right = request.routeOptions.config.right;
    if (request.session === null || right === undefined || !needsPresence(right)) return;
    presence.verify(request.session, header(request, PRESENCE_HEADER), request.method, pathOf(request), request.body);
  });

  registerRoutes(app, options, "station");
  return app;
}

/**
 * API сопровождения на loopback (APP-34): токен локального доступа; маршрут без пометки maintenance —
 * 403 maintenance_only; подтверждения присутствия здесь нет — версию Реестра удостоверяет подпись
 * Ключом Координатора (NET-54).
 */
export function buildMaintenanceApp(options: AppOptions): App {
  const { db, token } = options;
  const app = createBase(options, "maintenance");

  app.addHook("onRequest", async (request) => {
    if (request.routeOptions.url === undefined) return;
    const config = request.routeOptions.config;
    if (config.public === true) return;
    checkApiVersion(request);
    if (!sameToken(bearer(request), token)) throw new ApiError("unauthorized");
    if (config.maintenance === undefined || config.maintenance === false) throw new ApiError("maintenance_only");
    if (config.maintenance !== "member") return;
    const memberId = header(request, MEMBER_HEADER);
    if (memberId === undefined) throw new ApiError("unknown_member", { member: message("value_not_given_member") });
    request.memberRole = assertActor(db, memberId, config.right as Action);
    request.memberId = memberId;
  });

  registerRoutes(app, options, "maintenance");
  return app;
}
