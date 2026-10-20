// GET /api/journal — журнал с фильтрами и страницами (INBOX-32; contracts/http-api.md).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { JournalQuery, JournalResponse } from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { queryJournal } from "../../bank/journal-query.ts";
import type { JournalCursor } from "../../bank/journal-cursor.ts";

export function journalRoutes(app: FastifyInstance, db: Db, cursors: JournalCursor): void {
  app
    .withTypeProvider<TypeBoxTypeProvider>()
    .get("/api/journal", { schema: { querystring: JournalQuery, response: { 200: JournalResponse } }, config: { right: "journal.read" } }, async (request) =>
      queryJournal(db, request.query, { role: request.memberRole }, cursors),
    );
}
