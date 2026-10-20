// Маршруты состава Группы (contracts/http-api.md фич 001 и 002): первый Старший без заголовка
// автора (ROLE-26); чтение состава — все роли (ROLE-36); заведение, смена и отзыв — Старший (ROLE-21).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  BootstrapRequest,
  CreateMemberRequest,
  ErrorBody,
  Member,
  MemberIdParams,
  MembersResponse,
  RevokeMemberRequest,
  UpdateMemberRequest,
} from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { ApiError } from "../errors.ts";
import { bootstrapFirstSenior } from "../../members/bootstrap.ts";
import { createMember, getMember, listMembers, revokeMember, updateMember } from "../../members/members.ts";

export function memberRoutes(app: FastifyInstance, db: Db): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.post(
    "/api/members/bootstrap",
    { schema: { body: BootstrapRequest, response: { 201: Member } }, config: { noMember: true, maintenance: true, onlyMaintenance: true } },
    async (request, reply) => reply.status(201).send(bootstrapFirstSenior(db, request.body)),
  );

  api.get("/api/members", { schema: { response: { 200: MembersResponse } }, config: { right: "member.read" } }, async () => ({
    items: listMembers(db),
  }));

  api.get(
    "/api/members/:id",
    { schema: { params: MemberIdParams, response: { 200: Member } }, config: { right: "member.read" } },
    async (request) => {
      const member = getMember(db, request.params.id);
      if (member === undefined) throw new ApiError("not_found", { id: request.params.id }, {}, "member_not_found");
      return member;
    },
  );

  api.post(
    "/api/members",
    { schema: { body: CreateMemberRequest, response: { 201: Member } }, config: { right: "member.create" } },
    async (request, reply) => reply.status(201).send(createMember(db, request.body, request.memberId)),
  );

  api.patch(
    "/api/members/:id",
    // 409 version_conflict несёт current — текущую запись Члена Группы (research R7).
    {
      schema: { params: MemberIdParams, body: UpdateMemberRequest, response: { 200: Member, 409: ErrorBody } },
      config: { right: "member.update" },
    },
    async (request) => updateMember(db, request.params.id, request.body, request.memberId),
  );

  api.post(
    "/api/members/:id/revoke",
    {
      schema: { params: MemberIdParams, body: RevokeMemberRequest, response: { 200: Member, 409: ErrorBody } },
      config: { right: "member.revoke" },
    },
    async (request) => revokeMember(db, request.params.id, request.body, request.memberId),
  );
}
