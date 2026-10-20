// Маршруты Станций и Приглашений (contracts/http-api.md, contracts/stanciya-v1.md фичи 004): приём
// Станции без сеанса (STATION-16), вид «Станции» Старшим (VIEW-47), отзыв и сдача без присутствия
// (STATION-17, STATION-20), команда удаления сеансу «только удаление» (STATION-22), параметры Группы,
// Приглашения — выпуск с подтверждением присутствия, перечень, отмена (STATION-13, STATION-44);
// Приглашение по STATION-43 — только API сопровождения.
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  AcceptRequest,
  AcceptResponse,
  InvitationIdParams,
  InvitationView,
  InvitationsResponse,
  IssueInvitationRequest,
  IssueInvitationResponse,
  DeletionCommand,
  DeletionConfirmRequest,
  GroupSettings,
  GroupSettingsPatch,
  RevokeStationRequest,
  StationIdParams,
  StationView,
  StationsResponse,
} from "@aristotel/protocol";
import { ApiError } from "../errors.ts";
import { broadcastPassageList } from "../../passage/passage-list.ts";
import { acceptStation, cancelInvitation, issueInvitation, issueSeniorInvitation, listInvitations, type InvitationContext } from "../../stations/invitations.ts";
import { DeletionCommands, listStations, readGroupSettings, revokeStation, updateGroupSettings } from "../../stations/stations.ts";

export function stationRoutes(app: FastifyInstance, ctx: InvitationContext, deletions: DeletionCommands = new DeletionCommands()): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.post(
    "/api/stations/accept",
    { schema: { body: AcceptRequest, response: { 201: AcceptResponse } }, config: { noSession: true } },
    async (request, reply) => reply.status(201).send(acceptStation(ctx, request.body)),
  );

  api.get("/api/stations", { schema: { response: { 200: StationsResponse } }, config: { right: "station.read" } }, async () => ({
    items: listStations(ctx.db),
  }));

  api.post(
    "/api/stations/:id/revoke",
    { schema: { params: StationIdParams, body: RevokeStationRequest, response: { 200: StationView } }, config: { right: "station.revoke" } },
    async (request) => revokeStation(ctx.db, request.params.id, request.body.reason, request.memberId),
  );

  // Команда удаления — только сеансу «только удаление» (STATION-22, contracts/stanciya-v1.md).
  api.get("/api/station/deletion", { schema: { response: { 200: DeletionCommand } }, config: { sessionOnly: true, deleteOnly: true } }, async (request) => {
    if (request.session?.scope !== "delete-only") throw new ApiError("station_delete_only");
    return deletions.issue(request.session);
  });

  api.post(
    "/api/station/deletion/confirm",
    { schema: { body: DeletionConfirmRequest }, config: { sessionOnly: true, deleteOnly: true } },
    async (request, reply) => {
      if (request.session?.scope !== "delete-only") throw new ApiError("station_delete_only");
      deletions.confirm(ctx.db, request.session, request.body.commandId, request.body.signature);
      // Ключ уходит из перечня Прохода после того, как ответ ушёл Станции.
      reply.raw.once("finish", () => setTimeout(broadcastPassageList, 500).unref());
      return { ok: true };
    },
  );

  api.get("/api/group-settings", { schema: { response: { 200: GroupSettings } }, config: { right: "member.read" } }, async () => readGroupSettings(ctx.db));

  api.patch(
    "/api/group-settings",
    { schema: { body: GroupSettingsPatch, response: { 200: GroupSettings } }, config: { right: "group-setting.update" } },
    async (request) => updateGroupSettings(ctx.db, request.body, request.memberId),
  );

  api.post(
    "/api/invitations",
    { schema: { body: IssueInvitationRequest, response: { 201: IssueInvitationResponse } }, config: { right: "invitation.issue" } },
    async (request, reply) => reply.status(201).send(issueInvitation(ctx, request.memberId, request.body.memberId)),
  );

  api.post(
    "/api/invitations/senior",
    {
      schema: { body: IssueInvitationRequest, response: { 201: IssueInvitationResponse } },
      config: { right: "invitation.issue", maintenance: true, onlyMaintenance: true },
    },
    async (request, reply) => reply.status(201).send(issueSeniorInvitation(ctx, request.body.memberId)),
  );

  api.get("/api/invitations", { schema: { response: { 200: InvitationsResponse } }, config: { right: "invitation.read" } }, async () => ({
    items: listInvitations(ctx.db),
  }));

  api.post(
    "/api/invitations/:id/cancel",
    { schema: { params: InvitationIdParams, response: { 200: InvitationView } }, config: { right: "invitation.cancel" } },
    async (request) => cancelInvitation(ctx.db, request.memberId, request.params.id),
  );
}
