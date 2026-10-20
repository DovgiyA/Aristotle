// Маршруты Материалов (contracts/http-api.md фичи 006): регистрация, чтение, Заверения. Право
// маршрута — до разбора тела (FR-005 фичи 002); регистрация — только через сеанс Станции: Заверение
// подписано Станцией сеанса (STATION-07, STATION-29).
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { createReadStream } from "node:fs";
import {
  BankRecord,
  MATERIAL_OFFSET_HEADER,
  MATERIAL_PART_BYTES,
  MATERIAL_PART_SLACK,
  MaterialAttestationsResponse,
  MaterialDeleteRequest,
  MaterialIdParams,
  MaterialKindRequest,
  MaterialKindResponse,
  MaterialListQuery,
  MaterialListResponse,
  MaterialOffsetResponse,
  RegisterMaterialRequest,
} from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import { ApiError } from "../errors.ts";
import { getRecord, withView } from "../../bank/records.ts";
import { registerMaterial } from "../../materials/register.ts";
import { attestationMark, readMaterialState } from "../../materials/type.ts";
import { acceptPart, deliveryOffset, withMaterialLock, type DeliveryActor } from "../../materials/upload.ts";
import { materialFilePath } from "../../materials/tree.ts";
import { changeKind } from "../../materials/kind.ts";
import { deleteMaterial } from "../../materials/delete.ts";
import type { Reader } from "../../bank/visibility.ts";

/** Запись о Материале, если читающий её видит; иначе — 404, как несуществующей (VIEW-16). */
export function visibleMaterial(db: Db, id: string, reader: Reader): BankRecord {
  const record = getRecord(db, id, reader);
  if (record === undefined || record.type !== "material") throw new ApiError("not_found", { id });
  return record;
}

/** Диапазон байт из Range: «bytes=a-b», «bytes=a-», «bytes=-n»; не разобрать — весь файл. */
function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  if (header === undefined || !header.startsWith("bytes=") || header.includes(",")) return undefined;
  const [a = "", b = ""] = header.slice("bytes=".length).split("-");
  const digits = (x: string) => x !== "" && [...x].every((c) => c >= "0" && c <= "9");
  if (a === "" && digits(b)) return size === 0 ? "unsatisfiable" : { start: Math.max(0, size - Number(b)), end: size - 1 };
  if (!digits(a) || (b !== "" && !digits(b))) return undefined;
  const start = Number(a);
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export function materialRoutes(app: FastifyInstance, db: Db, dataDir: string | undefined): void {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const treeDir = (): string => {
    if (dataDir === undefined) throw new ApiError("storage_unavailable");
    return dataDir;
  };
  const deliveryActor = (request: { memberId: string; memberRole: DeliveryActor["role"]; session: { stationId: string } | null }): DeliveryActor => ({
    memberId: request.memberId,
    role: request.memberRole,
    stationId: request.session?.stationId ?? null,
  });

  // Часть файла — сырые байты: предел тела — часть и запас (research R6).
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MATERIAL_PART_BYTES + MATERIAL_PART_SLACK }, (_request, body, done) => done(null, body));

  api.post("/api/materials", { schema: { body: RegisterMaterialRequest, response: { 201: BankRecord } }, config: { right: "material.register" } }, async (request, reply) => {
    const record = registerMaterial(db, request.body, { memberId: request.memberId, stationId: request.session?.stationId ?? null });
    return reply.status(201).send(withView(db, record, { role: request.memberRole }));
  });

  api.get("/api/materials", { schema: { querystring: MaterialListQuery, response: { 200: MaterialListResponse } }, config: { right: "record.read" } }, async (request) => {
    const { case: caseId, document, deleted } = request.query;
    if ((caseId === undefined) === (document === undefined)) throw new ApiError("invalid_request", { detail: "case | document" });
    const reader = { role: request.memberRole };
    const rows = db
      .prepare(`SELECT s.id FROM material_state s JOIN record r ON r.id = s.id WHERE s.ownerType = ? AND s.ownerId = ? ${deleted === "include" ? "" : "AND s.deletedAt IS NULL"} ORDER BY r.createdAt, s.id`)
      .all(caseId === undefined ? "document" : "case", caseId ?? document ?? "");
    const items = rows.map((r) => getRecord(db, String(r["id"]), reader)).filter((r): r is BankRecord => r !== undefined);
    return { items: items.map((r) => withView(db, r, reader)) };
  });

  api.get("/api/materials/:id", { schema: { params: MaterialIdParams, response: { 200: BankRecord } }, config: { right: "record.read" } }, async (request) => {
    const reader = { role: request.memberRole };
    return withView(db, visibleMaterial(db, request.params.id, reader), reader);
  });

  // Заверения как получены — Участнику и Старшему: Заверение указывает на Станцию, а значит на человека
  // (STATION-33); Наблюдателю — 403.
  api.get("/api/materials/:id/attestations", { schema: { params: MaterialIdParams, response: { 200: MaterialAttestationsResponse } }, config: { right: "material.register" } }, async (request) => {
    visibleMaterial(db, request.params.id, { role: request.memberRole });
    const current = readMaterialState(db, request.params.id)?.currentAttestation;
    const items = db
      .prepare("SELECT n, json, stationId, stationKey, receivedAt FROM material_attestation WHERE materialId = ? ORDER BY n")
      .all(request.params.id)
      .map((r) => ({
        n: Number(r["n"]),
        current: Number(r["n"]) === current,
        mark: attestationMark(db, String(r["stationId"]), String(r["stationKey"])),
        receivedAt: String(r["receivedAt"]),
        attestation: JSON.parse(String(r["json"])) as Record<string, unknown>,
      }));
    return { items };
  });

  api.get("/api/materials/:id/content/offset", { schema: { params: MaterialIdParams, response: { 200: MaterialOffsetResponse } }, config: { right: "material.deliver" } }, async (request) =>
    deliveryOffset(db, request.params.id, deliveryActor(request)),
  );

  api.put(
    "/api/materials/:id/content",
    { schema: { params: MaterialIdParams }, bodyLimit: MATERIAL_PART_BYTES + MATERIAL_PART_SLACK, config: { right: "material.deliver" } },
    async (request, reply) => {
      const header = request.headers[MATERIAL_OFFSET_HEADER];
      const offset = typeof header === "string" && header !== "" && [...header].every((c) => c >= "0" && c <= "9") ? Number(header) : Number.NaN;
      if (!Number.isSafeInteger(offset)) throw new ApiError("invalid_request", { detail: MATERIAL_OFFSET_HEADER });
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (request.headers["content-type"] !== "application/octet-stream" && body.length > 0) throw new ApiError("invalid_request", { detail: "content-type" });
      const result = await acceptPart(db, treeDir(), request.params.id, deliveryActor(request), offset, body);
      if (!result.done) return reply.send({ received: result.received });
      return reply.send({ ...withView(db, result.record, { role: request.memberRole }), received: String(result.record.fields["size"]) });
    },
  );

  // Файл доставленного Материала — потоком, с Range: так Наблюдатель видит Материал «только через
  // программу» (BANK-15); Секрет-Материала у Наблюдателя нет (VIEW-16).
  api.get("/api/materials/:id/content", { schema: { params: MaterialIdParams }, config: { right: "record.read" } }, async (request, reply) => {
    const record = visibleMaterial(db, request.params.id, { role: request.memberRole });
    const state = readMaterialState(db, record.id);
    if (state === undefined) throw new ApiError("not_found", { id: record.id });
    if (state.deletedAt !== null) throw new ApiError("material_deleted");
    if (state.delivery !== "delivered") throw new ApiError("delivery_not_done");
    const size = Number(record.fields["size"]);
    const file = materialFilePath(treeDir(), { type: state.ownerType, id: state.ownerId }, String(record.fields["path"]));
    const range = byteRange(request.headers.range, size);
    reply.header("accept-ranges", "bytes").type("application/octet-stream");
    if (range === "unsatisfiable") return reply.status(416).header("content-range", `bytes */${size}`).send();
    if (range === undefined) return reply.header("content-length", String(size)).send(createReadStream(file));
    return reply
      .status(206)
      .header("content-range", `bytes ${range.start}-${range.end}/${size}`)
      .header("content-length", String(range.end - range.start + 1))
      .send(createReadStream(file, { start: range.start, end: range.end }));
  });

  // Вид: два маршрута, потому что право проверяется до разбора тела (research R1 фичи 002, R8 фичи 006):
  // перевод образа или логической копии в другой вид — только /kind/release (Старший, присутствие).
  for (const [suffix, release] of [["kind", false], ["kind/release", true]] as const) {
    api.post(
      `/api/materials/:id/${suffix}`,
      { schema: { params: MaterialIdParams, body: MaterialKindRequest, response: { 200: MaterialKindResponse } }, config: { right: release ? "material.kind.release" : "material.kind.set" } },
      async (request) => {
        const result = changeKind(db, request.params.id, request.body, request.memberId, release);
        const view = withView(db, result.record, { role: request.memberRole });
        return result.warning === undefined ? view : { ...view, warning: result.warning };
      },
    );
  }

  api.post(
    "/api/materials/:id/delete",
    { schema: { params: MaterialIdParams, body: MaterialDeleteRequest, response: { 200: BankRecord } }, config: { right: "material.delete" } },
    // Под блокировкой Материала: удаление не пересекается с приёмом последней части (T086).
    async (request) => withView(db, await withMaterialLock(request.params.id, () => deleteMaterial(db, treeDir(), request.params.id, request.body, request.memberId)), { role: request.memberRole }),
  );

  // Материалы, заверенные Станцией, — основа перечня «что было на утраченной Станции» (STATION-21).
  api.get("/api/stations/:id/materials", { schema: { params: MaterialIdParams, response: { 200: MaterialListResponse } }, config: { right: "material.station-list" } }, async (request) => {
    const reader = { role: request.memberRole };
    const items = db
      .prepare("SELECT DISTINCT a.materialId AS id, r.createdAt FROM material_attestation a JOIN record r ON r.id = a.materialId WHERE a.stationId = ? ORDER BY r.createdAt, a.materialId")
      .all(request.params.id)
      .map((r) => getRecord(db, String(r["id"]), reader))
      .filter((r): r is BankRecord => r !== undefined);
    return { items: items.map((r) => withView(db, r, reader)) };
  });
}
