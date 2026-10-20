// Маршруты сеанса Станции (contracts/stanciya-v1.md фичи 004): вызов и вход без сеанса (STATION-10),
// конец сеанса (STATION-34), события Станции — перечень Проходов при смене записи Группы (STATION-42).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { ChallengeResponse, SessionRequest, SessionResponse, StationEventsQuery, StationEventsResponse } from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { endSession, exportEkm, login, type SessionChallenges } from "../../stations/sessions.ts";
import { networkEvents } from "../../network/events.ts";
import { registryState } from "../../network/registry.ts";

export interface SessionRouteContext {
  db: Db;
  challenges: SessionChallenges;
  passages: () => string[];
  /** Долгий запрос событий — до 30 с (стенд — короче). */
  eventsWaitMs: number;
}

function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") === true ? header.slice(7) : "";
}

export function sessionRoutes(app: FastifyInstance, ctx: SessionRouteContext): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.post("/api/session/challenge", { schema: { response: { 200: ChallengeResponse } }, config: { noSession: true } }, async () => ctx.challenges.issue());

  api.post(
    "/api/session",
    { schema: { body: SessionRequest, response: { 201: SessionResponse } }, config: { noSession: true } },
    async (request, reply) =>
      reply.status(201).send(login({ db: ctx.db, challenges: ctx.challenges, passages: ctx.passages }, request.body, exportEkm(request.raw.socket), bearer(request.headers.authorization))),
  );

  api.delete("/api/session", { config: { sessionOnly: true, deleteOnly: true } }, async (request, reply) => {
    endSession(ctx.db, request.session!);
    return reply.status(204).send();
  });

  // Номер изменений — номер последней применённой версии Реестра: смена записи Группы приходит с ней.
  api.get(
    "/api/station/events",
    { schema: { querystring: StationEventsQuery, response: { 200: StationEventsResponse } }, config: { sessionOnly: true } },
    async (request, reply) => {
      const current = () => registryState(ctx.db).current?.number ?? 0;
      const after = request.query.after ?? 0;
      if (current() > after) return { seq: current(), passages: ctx.passages() };
      const changed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => done(false), ctx.eventsWaitMs);
        const onApplied = () => done(true);
        const onClose = () => done(false);
        function done(value: boolean): void {
          clearTimeout(timer);
          networkEvents.off("registry-applied", onApplied);
          request.raw.off("close", onClose);
          resolve(value);
        }
        networkEvents.on("registry-applied", onApplied);
        request.raw.once("close", onClose);
      });
      // Ничего не изменилось за время ожидания — 204 без тела.
      if (!changed || current() <= after) {
        void reply.code(204 as 200).send(undefined as never);
        return;
      }
      return { seq: current(), passages: ctx.passages() };
    },
  );
}
