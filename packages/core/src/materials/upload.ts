// Приём файла Материала частями с докачкой (BANK-18, BANK-19, STATION-07, STATION-31; research R6 фичи
// 006; contracts/http-api.md «Доставка»): смещение задаёт Опорная станция — принятое в material_upload;
// часть дописывается в .incoming с fsync; последняя часть запускает сверку SHA-256 по временному файлу
// целиком. Сошёлся — файл и Заверения в дереве, «не доставлен» снят; нет — принятое сброшено, Материал
// «не доставлен». Доставлять может Станция Члена Группы, зарегистрировавшего Материал, или Станция
// Старшего (FR-008a); Станция Старшего перехватывает доставку сразу (research R6).
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, fsyncSync, ftruncateSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { MATERIAL_PART_BYTES, MATERIAL_UPLOAD_ABANDON_MS, attestationFileText, type Attestation, type BankRecord, type Role } from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";
import { inTransaction, type Db } from "../db/open.ts";
import { getRecord } from "../bank/records.ts";
import { readMaterialState, type MaterialState } from "./type.ts";
import { incomingPath, materialFilePath, placeDelivered, removeFromTree } from "./tree.ts";
import { materialJournal } from "./journal.ts";

export interface DeliveryActor {
  memberId: string;
  role: Role;
  /** Станция сеанса; null — служба (носитель, фича 006 US6). */
  stationId: string | null;
}

/** Точки сбоя — только для тестов (T032, T033). */
export interface UploadFaults {
  /** Перед записью части: бросить ENOSPC и т. п. */
  beforeWrite?: () => void;
  /** После переименования в дерево, до транзакции «доставлен». */
  afterPlace?: () => void;
}

interface Upload {
  stationId: string;
  received: number;
  updatedAt: string;
  /** Станция, у которой доставку перехватили или продолжили брошенную (research R6). */
  takenOverFrom: string | null;
}

function readUpload(db: Db, id: string): Upload | undefined {
  const row = db.prepare("SELECT stationId, received, updatedAt, takenOverFrom FROM material_upload WHERE materialId = ?").get(id);
  return row === undefined
    ? undefined
    : { stationId: String(row["stationId"]), received: Number(row["received"]), updatedAt: String(row["updatedAt"]), takenOverFrom: row["takenOverFrom"] === null ? null : String(row["takenOverFrom"]) };
}

function material(db: Db, id: string): { record: BankRecord; state: MaterialState } {
  const record = getRecord(db, id);
  const state = readMaterialState(db, id);
  if (record === undefined || record.type !== "material" || state === undefined) throw new ApiError("not_found", { id });
  return { record, state };
}

function caseOf(record: BankRecord): string | null {
  return typeof record.fields["case"] === "string" ? record.fields["case"] : null;
}

function attestationTexts(db: Db, id: string): string[] {
  return db
    .prepare("SELECT json FROM material_attestation WHERE materialId = ? ORDER BY n")
    .all(id)
    .map((r) => attestationFileText(JSON.parse(String(r["json"])) as Attestation));
}

/** Право доставки сверх роли (FR-008a): Станция того, кто зарегистрировал, или Станция Старшего. */
function assertDeliverer(record: BankRecord, actor: DeliveryActor): void {
  if (actor.stationId === null) return;
  if (actor.role === "senior" || record.createdBy === actor.memberId) return;
  throw new ApiError("delivery_station");
}

/** Сколько принято — GET …/content/offset. */
export function deliveryOffset(db: Db, id: string, actor: DeliveryActor): { received: string; size: string } {
  const { record, state } = material(db, id);
  assertDeliverer(record, actor);
  if (state.deletedAt !== null) throw new ApiError("material_deleted");
  const size = String(record.fields["size"]);
  if (state.delivery === "delivered") return { received: size, size };
  return { received: String(readUpload(db, id)?.received ?? 0), size };
}

const locks = new Map<string, Promise<unknown>>();

/** Части одного Материала — по очереди: смещение и дописывание не перемешиваются. */
async function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type PartResult = { done: false; received: string } | { done: true; record: BankRecord };

/**
 * Отказ доставки — в журнал (data-model.md «Виды действий журнала»): кто, какая Станция, почему.
 * «Держит другая Станция» — одна запись на пару «Станция — держатель»: очередь Станции повторяет запрос,
 * и запись на каждый повтор была бы шумом (T091).
 */
function rejectDelivery(
  db: Db,
  id: string,
  record: BankRecord,
  actor: DeliveryActor,
  code: "delivery_station" | "delivery_held" | "material_deleted" | "delivery_hash_mismatch",
  via: "passage" | "media",
  holder?: string,
): void {
  if (code === "delivery_held") {
    const seen = db
      .prepare(
        "SELECT 1 AS x FROM journal WHERE subjectId = ? AND action = 'material.deliver.reject' AND json_extract(details, '$.code') = 'delivery_held' AND json_extract(details, '$.station') = ? AND json_extract(details, '$.holder') = ? LIMIT 1",
      )
      .get(id, actor.stationId, holder ?? null);
    if (seen !== undefined) return;
  }
  const details: Record<string, unknown> = { code, station: actor.stationId, via };
  if (holder !== undefined) details["holder"] = holder;
  inTransaction(db, () => materialJournal(db, "material.deliver.reject", id, actor.stationId === null ? null : actor.memberId, details, caseOf(record)));
}

/** Держатель доставки бросил её: части не приходили час или его Станция не действует (research R6; Edge Cases). */
function holderAbandoned(db: Db, upload: Upload, now: Date): boolean {
  if (now.getTime() - Date.parse(upload.updatedAt) > MATERIAL_UPLOAD_ABANDON_MS) return true;
  const station = db.prepare("SELECT state FROM station WHERE id = ?").get(upload.stationId);
  return station === undefined || String(station["state"]) !== "active";
}

/** Принять часть файла (PUT …/content). */
export async function acceptPart(db: Db, dataDir: string, id: string, actor: DeliveryActor, offset: number, body: Uint8Array, faults: UploadFaults = {}): Promise<PartResult> {
  return await serialized(id, async () => {
    const { record, state } = material(db, id);
    try {
      assertDeliverer(record, actor);
    } catch (error) {
      rejectDelivery(db, id, record, actor, "delivery_station", "passage");
      throw error;
    }
    if (state.deletedAt !== null) {
      rejectDelivery(db, id, record, actor, "material_deleted", "passage");
      throw new ApiError("material_deleted");
    }
    if (state.delivery === "delivered") throw new ApiError("delivery_done");
    const size = Number(record.fields["size"]);
    const upload = readUpload(db, id);
    const now = new Date();
    let takenOverFrom = upload?.takenOverFrom ?? undefined;
    if (upload !== undefined && actor.stationId !== null && upload.stationId !== "" && upload.stationId !== actor.stationId) {
      if (!holderAbandoned(db, upload, now) && actor.role !== "senior") {
        rejectDelivery(db, id, record, actor, "delivery_held", "passage", upload.stationId);
        const until = new Date(Date.parse(upload.updatedAt) + MATERIAL_UPLOAD_ABANDON_MS).toISOString();
        throw new ApiError("delivery_held", { until }, { until });
      }
      // Перехват или продолжение брошенной: прежний держатель доходит до журнала доставки (research R6).
      takenOverFrom = upload.stationId;
    }
    const received = upload?.received ?? 0;
    if (offset !== received) throw new ApiError("delivery_offset", { offset: String(offset), received: String(received) }, { received: String(received) });
    if (body.length > MATERIAL_PART_BYTES || received + body.length > size) throw new ApiError("delivery_part_too_large");
    if (body.length === 0 && received < size) throw new ApiError("delivery_part_too_large");
    const incoming = incomingPath(dataDir, id);
    // Повтор последней части после сбоя размещения: файл уже в дереве, а .incoming нет (T087).
    const resumeFromTree = received === size && body.length === 0 && !existsSync(incoming) && treeFile(dataDir, record, state) !== undefined;
    if (!resumeFromTree) {
      // Часть, записанная до сбоя, но не учтённая в БД, отрезается: источник истины — material_upload.
      const fd = openSync(incoming, existsSync(incoming) ? "r+" : "w", 0o600);
      try {
        ftruncateSync(fd, received);
        try {
          faults.beforeWrite?.();
          if (body.length > 0) writeSync(fd, body, 0, body.length, received);
          fsyncSync(fd);
        } catch (error) {
          ftruncateSync(fd, received);
          if ((error as { code?: string }).code === "ENOSPC") throw new ApiError("delivery_no_space");
          throw error;
        }
      } finally {
        closeSync(fd);
      }
    }
    const total = received + body.length;
    const at = now.toISOString();
    inTransaction(db, () => {
      db.prepare(
        "INSERT INTO material_upload (materialId, stationId, received, startedAt, updatedAt, takenOverFrom) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (materialId) DO UPDATE SET stationId = excluded.stationId, received = excluded.received, updatedAt = excluded.updatedAt, takenOverFrom = excluded.takenOverFrom",
      ).run(id, actor.stationId ?? "", total, at, at, takenOverFrom ?? null);
    });
    if (total < size) return { done: false, received: String(total) };
    return { done: true, record: await finish(db, dataDir, id, record, state, actor, "passage", takenOverFrom, faults) };
  });
}

/** Файл Материала в дереве — обычный файл, а не каталог (T076). */
function treeFile(dataDir: string, record: BankRecord, state: MaterialState): string | undefined {
  const file = materialFilePath(dataDir, { type: state.ownerType, id: state.ownerId }, String(record.fields["path"]));
  try {
    return statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Сверка SHA-256 и размещение в дереве; общий конец доставки через Проход и с носителя. */
async function finish(
  db: Db,
  dataDir: string,
  id: string,
  record: BankRecord,
  state: MaterialState,
  actor: DeliveryActor,
  via: "passage" | "media",
  takenOverFrom: string | undefined,
  faults: UploadFaults,
): Promise<BankRecord> {
  const incoming = incomingPath(dataDir, id);
  const source = existsSync(incoming) ? incoming : treeFile(dataDir, record, state);
  if (source === undefined) throw new ApiError("delivery_offset", { offset: "0", received: "0" }, { received: "0" });
  const sha256 = await fileSha256(source);
  // Пока шёл хэш, Материал могли удалить (T086): удаление ждёт той же блокировки, но проверка — здесь.
  if (readMaterialState(db, id)?.deletedAt !== null) {
    rmSync(incoming, { force: true });
    throw new ApiError("material_deleted");
  }
  const owner = { type: state.ownerType, id: state.ownerId };
  const path = String(record.fields["path"]);
  if (sha256 !== record.fields["sha256"] || statSync(source).size !== Number(record.fields["size"])) {
    if (source === incoming) rmSync(incoming, { force: true });
    else removeFromTree(dataDir, id, owner, path, state.currentAttestation);
    inTransaction(db, () => db.prepare("DELETE FROM material_upload WHERE materialId = ?").run(id));
    rejectDelivery(db, id, record, actor, "delivery_hash_mismatch", via);
    throw new ApiError("delivery_hash_mismatch");
  }
  try {
    placeDelivered(dataDir, id, owner, path, attestationTexts(db, id));
    faults.afterPlace?.();
  } catch (error) {
    // Нет места на Заверения — повтор последней части доведёт доставку по файлу в дереве (T087).
    if ((error as { code?: string }).code === "ENOSPC") throw new ApiError("delivery_no_space");
    throw error;
  }
  inTransaction(db, () => markDelivered(db, id, record, actor.stationId === null ? null : actor.memberId, { station: actor.stationId, via, ...(takenOverFrom === undefined ? {} : { takenOverFrom }) }, actor.stationId));
  return getRecord(db, id)!;
}

function markDelivered(db: Db, id: string, record: BankRecord, actorId: string | null, details: Record<string, unknown>, stationId: string | null): void {
  db.prepare("UPDATE material_state SET delivery = 'delivered', deliveredAt = ?, deliveredByStation = ? WHERE id = ? AND delivery = 'pending'").run(new Date().toISOString(), stationId, id);
  db.prepare("DELETE FROM material_upload WHERE materialId = ?").run(id);
  materialJournal(db, "material.deliver", id, actorId, details, caseOf(record));
}

/** Сделать под блокировкой Материала — удаление не пересекается с приёмом частей (T086). */
export async function withMaterialLock<T>(id: string, work: () => T): Promise<T> {
  return await serialized(id, async () => work());
}

/** Довести один Материал после сбоя (research R6, R10). */
async function reconcileOne(db: Db, dataDir: string, id: string): Promise<void> {
  const { record, state } = material(db, id);
  const owner = { type: state.ownerType, id: state.ownerId };
  const path = String(record.fields["path"]);
  if (state.treeCleanup || state.deletedAt !== null) {
    if (state.treeCleanup) {
      removeFromTree(dataDir, id, owner, path, state.currentAttestation);
      inTransaction(db, () => db.prepare("UPDATE material_state SET treeCleanup = 0 WHERE id = ?").run(id));
    }
    return;
  }
  if (state.delivery !== "pending") return;
  const file = treeFile(dataDir, record, state);
  if (file === undefined) return;
  const ok = (await fileSha256(file)) === record.fields["sha256"] && statSync(file).size === Number(record.fields["size"]);
  if (ok) {
    placeDelivered(dataDir, id, owner, path, attestationTexts(db, id));
    const station = readUpload(db, id)?.stationId ?? null;
    inTransaction(db, () => markDelivered(db, id, record, null, { station, via: "passage", recovered: true }, station));
  } else {
    removeFromTree(dataDir, id, owner, path, state.currentAttestation);
    inTransaction(db, () => db.prepare("DELETE FROM material_upload WHERE materialId = ?").run(id));
  }
}

/**
 * Согласование после сбоя (research R6, R10): файл в дереве у «не доставлен» — пересчёт SHA-256:
 * сошёлся — «доставлен» с recovered, нет — уборка; незавершённое удаление — уборка дерева. Сбой одного
 * Материала не мешает остальным и запуску службы (T076): он останется до следующего запуска.
 */
export async function reconcileMaterials(db: Db, dataDir: string): Promise<string[]> {
  const ids = db.prepare("SELECT id FROM material_state WHERE (delivery = 'pending' AND deletedAt IS NULL) OR treeCleanup = 1").all().map((r) => String(r["id"]));
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await reconcileOne(db, dataDir, id);
    } catch {
      failed.push(id);
    }
  }
  return failed;
}

export { finish as finishDelivery };
