// GET /api/cases/:id (contracts/http-api.md фичи 005): Кейс с Изделиями, подписью, отвеченностью
// обязательных полей (DATA-27) и недостающими разделами Отчёта (DATA-31). Наблюдатель Секрет-Кейса не
// видит — 404, как несуществующего (VIEW-16).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { RecordIdParams } from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { ApiError } from "../errors.ts";
import { getRecord, withView } from "../../bank/records.ts";
import { canSeeRecord } from "../../bank/visibility.ts";
import { caseAnswered, caseMissingSections } from "../../model/case-view.ts";

export function caseRoutes(app: FastifyInstance, db: Db): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.get("/api/cases/:id", { schema: { params: RecordIdParams }, config: { right: "record.read" } }, async (request) => {
    const reader = { role: request.memberRole };
    const record = getRecord(db, request.params.id, reader);
    if (record === undefined || record.type !== "case") throw new ApiError("not_found", { id: request.params.id });
    const items = db
      .prepare("SELECT r.id FROM record_case rc JOIN record r ON r.id = rc.recordId WHERE rc.caseId = ? AND r.type = 'item' ORDER BY r.createdAt, r.id")
      .all(record.id)
      .map((r) => getRecord(db, String(r["id"]), reader))
      .filter((r): r is NonNullable<typeof r> => r !== undefined && canSeeRecord(reader, r.secret))
      .map((r) => withView(db, r, reader));
    const withLabel = withView(db, record, reader);
    return {
      case: withLabel,
      items,
      label: String(withLabel.view?.["label"] ?? record.fields["number"]),
      answered: caseAnswered(db, record, items, reader),
      missingSections: caseMissingSections(db, record, items),
    };
  });
}
