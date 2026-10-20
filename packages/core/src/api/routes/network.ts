// Маршруты Сети (contracts/http-api.md фичи 003): открытые Ключи Группы, Ключи Координатора, Реестр
// Сети. Чтение — все роли (ROLE-37), изменения — Старший (NET-13); при недоступном Ключе Группы
// изменения — 409 group_key_unavailable (NET-53).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  CoordinatorKeyItem,
  CoordinatorKeyRegisterRequest,
  CoordinatorKeysResponse,
  DraftRequest,
  GroupKeyInfo,
  RegistryCurrent,
  RegistryNumberParams,
  RegistryState,
  type RelayLink,
} from "@aristotel/protocol";
import { ApiError } from "../errors.ts";
import { applyVersion, buildDraft, registryDocumentText, registryState } from "../../network/registry.ts";
import { listCoordinatorKeys, registerCoordinatorKey, withdrawCoordinatorKey } from "../../network/coordinator-keys.ts";
import type { Db } from "../../db/open.ts";
import type { Install } from "../../install/install.ts";
import type { GroupKeyHandle } from "../../network/group-key.ts";

/** Есть ли у Группы хоть одна принятая Станция (APP-34: регистрация ключа через CLI — до первой). */
function hasStations(db: Db): boolean {
  return db.prepare("SELECT 1 AS x FROM station LIMIT 1").get() !== undefined;
}

export interface NetworkContext {
  db: Db;
  install: Install;
  groupKey: GroupKeyHandle;
  /** Отпечаток TLS Опорной станции и связь Проходов — в GET /api/registry (фича 004). */
  tlsSpki?: () => string;
  relays?: () => RelayLink[];
}

export function networkRoutes(app: FastifyInstance, context: NetworkContext): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.get("/api/group-key", { schema: { response: { 200: GroupKeyInfo } }, config: { right: "registry.read", maintenance: true } }, async () =>
    context.groupKey.info(),
  );

  api.get(
    "/api/coordinator-keys",
    { schema: { response: { 200: CoordinatorKeysResponse } }, config: { right: "registry.read", maintenance: true } },
    async () => ({ items: listCoordinatorKeys(context.db) }),
  );

  api.post(
    "/api/coordinator-keys",
    {
      schema: { body: CoordinatorKeyRegisterRequest, response: { 201: CoordinatorKeyItem } },
      config: { right: "coordinator-key.register", maintenance: "member" },
    },
    async (request, reply) => {
      // На API сопровождения — только пока нет ни одной принятой Станции: Запуск Сети (APP-34).
      if (request.via === "maintenance" && hasStations(context.db)) throw new ApiError("maintenance_only");
      context.groupKey.assertAvailable();
      return reply.status(201).send(registerCoordinatorKey(context.db, request.memberId, request.body, context.install.installId));
    },
  );

  api.post(
    "/api/coordinator-keys/withdraw",
    { schema: { response: { 200: CoordinatorKeyItem } }, config: { right: "coordinator-key.withdraw" } },
    async (request) => withdrawCoordinatorKey(context.db, request.memberId),
  );

  api.get("/api/registry", { schema: { response: { 200: RegistryState } }, config: { right: "registry.read", maintenance: true } }, async () => ({
    ...registryState(context.db),
    ...(context.tlsSpki === undefined ? {} : { baseTlsSpki: context.tlsSpki() }),
    ...(context.relays === undefined ? {} : { relays: context.relays() }),
  }));

  // Применённая версия как хранится — Ретранслятор получит первую версию от своей станции (RELAY-19).
  api.get(
    "/api/registry/versions/:number",
    { schema: { params: RegistryNumberParams }, config: { right: "registry.read", maintenance: true } },
    async (request, reply) => {
      const text = registryDocumentText(context.db, request.params.number);
      if (text === undefined) throw new ApiError("not_found", { id: String(request.params.number) }, {}, "registry_version_not_found");
      return reply.type("application/json; charset=utf-8").send(text);
    },
  );

  api.post("/api/registry/draft", { schema: { body: DraftRequest }, config: { right: "registry.draft", maintenance: true } }, async (request) => {
    context.groupKey.assertAvailable();
    return buildDraft(context.db, context.groupKey, request.body);
  });

  // Тело — подписанный документ; предел тела документа 1 МиБ плюс обвязка (contracts/reestr-v1.md).
  api.post(
    "/api/registry/versions",
    {
      bodyLimit: 2 * 1024 * 1024,
      schema: { response: { 200: RegistryCurrent, 201: RegistryCurrent } },
      config: { right: "registry.apply", maintenance: true },
    },
    async (request, reply) => {
      // На API сопровождения автор — владелец подписавшего Ключа Координатора (NET-54, APP-34).
      const actor = request.via === "maintenance" ? ({ bySignature: true } as const) : { memberId: request.memberId };
      const result = applyVersion(context.db, context.groupKey, actor, JSON.stringify(request.body));
      return reply.status(result.status).send(result.current);
    },
  );
}
