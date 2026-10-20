// Маршруты Местного расширения (contracts/http-api.md фичи 005; DICT-05, DICT-07, DICT-45): предложения
// Участника или Старшего, решения Старшего, строки «Местного». Только API Станций.
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { LocalProposalRequest, LocalRejectRequest, RecordIdParams } from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { accept, listProposals, localExtensionView, propose, reject } from "../../local-extension/proposals.ts";

const StateQuery = Type.Object({ state: Type.Optional(Type.Union([Type.Literal("proposed"), Type.Literal("accepted"), Type.Literal("rejected")])) }, { additionalProperties: false });

export function localExtensionRoutes(app: FastifyInstance, db: Db): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.get("/api/local-extension", { config: { right: "dictionary.read" } }, async () => localExtensionView(db));
  api.get("/api/local-extension/proposals", { schema: { querystring: StateQuery }, config: { right: "dictionary.read" } }, async (request) => ({
    items: listProposals(db, request.query.state),
  }));
  api.post("/api/local-extension/proposals", { schema: { body: LocalProposalRequest }, config: { right: "local-extension.propose" } }, async (request, reply) =>
    reply.status(201).send(propose(db, request.memberId, request.body.kind, request.body.payload)),
  );
  api.post("/api/local-extension/proposals/:id/accept", { schema: { params: RecordIdParams }, config: { right: "local-extension.decide" } }, async (request) =>
    accept(db, request.memberId, request.params.id),
  );
  api.post("/api/local-extension/proposals/:id/reject", { schema: { params: RecordIdParams, body: LocalRejectRequest }, config: { right: "local-extension.decide" } }, async (request) =>
    reject(db, request.memberId, request.params.id, request.body.reason),
  );
}
