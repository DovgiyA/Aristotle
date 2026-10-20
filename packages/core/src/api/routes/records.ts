// Маршруты Записей (contracts/http-api.md). Удаления Записи и правки истории нет (BANK-06, BANK-07).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  BankRecord,
  CreateRecordRequest,
  ErrorBody,
  HistoryResponse,
  RecordIdParams,
  SecretMarkRequest,
  UpdateRecordRequest,
} from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { ApiError } from "../errors.ts";
import { createRecord, getHistory, getRecord, setSecret, updateRecord, withView } from "../../bank/records.ts";

export function recordRoutes(app: FastifyInstance, db: Db): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.post("/api/records", { schema: { body: CreateRecordRequest, response: { 201: BankRecord } }, config: { right: "record.create" } }, async (request, reply) =>
    reply.status(201).send(withView(db, createRecord(db, request.body, request.memberId), { role: request.memberRole })),
  );

  api.get("/api/records/:id", { schema: { params: RecordIdParams, response: { 200: BankRecord } }, config: { right: "record.read" } }, async (request) => {
    // Для Наблюдателя Секрет-Записи нет — тот же 404, что для несуществующей (VIEW-16).
    const record = getRecord(db, request.params.id, { role: request.memberRole });
    if (record === undefined) throw new ApiError("not_found", { id: request.params.id });
    return withView(db, record, { role: request.memberRole });
  });

  api.patch(
    "/api/records/:id",
    // 409 version_conflict несёт current и changesSince (BANK-09); сообщение — из locales/ru.json.
    { schema: { params: RecordIdParams, body: UpdateRecordRequest, response: { 200: BankRecord, 409: ErrorBody } }, config: { right: "record.update" } },
    async (request) => withView(db, updateRecord(db, request.params.id, request.body, request.memberId), { role: request.memberRole }),
  );

  api.get("/api/records/:id/history", { schema: { params: RecordIdParams, response: { 200: HistoryResponse } }, config: { right: "record.read" } }, async (request) => {
    if (getRecord(db, request.params.id, { role: request.memberRole }) === undefined) throw new ApiError("not_found", { id: request.params.id });
    return { items: getHistory(db, request.params.id, { role: request.memberRole }) };
  });

  // Метка Секрет: два маршрута, потому что право проверяется до разбора тела (ROLE-17, ROLE-18; research R1, R2).
  for (const [action, value] of [["mark", true], ["unmark", false]] as const) {
    api.post(
      `/api/records/:id/secret/${action}`,
      {
        schema: { params: RecordIdParams, body: SecretMarkRequest, response: { 200: BankRecord, 409: ErrorBody } },
        config: { right: value ? "record.secret.mark" : "record.secret.unmark" },
      },
      // Ответ — с видом, как создание и правка (BANK-35): подпись, метки.
      async (request) => withView(db, setSecret(db, request.params.id, request.body, value, request.memberId), { role: request.memberRole }),
    );
  }
}
