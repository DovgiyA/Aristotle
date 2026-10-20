// Заведение Записи о Материале до доставки файла (BANK-17, BANK-19, STATION-29 … STATION-31; research
// R3, R5 фичи 006): Заверение проверяется, Запись, состояние «не доставлен» и Заверения пишутся одной
// транзакцией с журналом material.register; отказ Заверения — запись material.attestation.reject
// отдельной транзакцией: отказ виден Старшим, даже когда Записи нет (data-model.md «Виды действий журнала»).
import { MATERIAL_RECORD_TYPE, checkMaterialPath, type Attestation, type BankRecord, type RegisterMaterialRequest } from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";
import { inTransaction, type Db } from "../db/open.ts";
import { createRecord } from "../bank/records.ts";
import { AttestationError, verifyForRegistration } from "./attestation.ts";

export interface RegisterActor {
  memberId: string;
  /** Станция сеанса; null — внутренний вызов без сеанса (фичи 009, 015, 017). */
  stationId: string | null;
}

function writeRejection(db: Db, request: RegisterMaterialRequest, memberId: string, error: AttestationError): void {
  const caseId = "case" in request.owner ? request.owner.case : null;
  const knownCase = caseId !== null && db.prepare("SELECT 1 AS x FROM record WHERE id = ? AND type = 'case'").get(caseId) !== undefined;
  const details: Record<string, unknown> = { code: error.code };
  if (error.station !== undefined) details["station"] = error.station;
  inTransaction(db, () => {
    db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details, caseId) VALUES (?, ?, 'material.attestation.reject', 'record', ?, ?, ?)").run(
      new Date().toISOString(),
      memberId,
      request.id,
      JSON.stringify(details),
      knownCase ? caseId : null,
    );
  });
}

function insertAttestations(db: Db, id: string, list: Attestation[], at: string): void {
  const insert = db.prepare("INSERT INTO material_attestation (materialId, n, json, stationId, stationKey, receivedAt) VALUES (?, ?, ?, ?, ?, ?)");
  list.forEach((a, i) => insert.run(id, i + 1, JSON.stringify(a), a.station, a.stationKey, at));
}

export function registerMaterial(db: Db, request: RegisterMaterialRequest, actor: RegisterActor): BankRecord {
  const owner = "case" in request.owner ? { type: "case" as const, id: request.owner.case } : { type: "document" as const, id: request.owner.document };
  if (db.prepare("SELECT 1 AS x FROM record WHERE id = ?").get(request.id) !== undefined) throw new ApiError("material_id_taken", { id: request.id });
  let verified: { current: Attestation; previous: Attestation[] };
  try {
    verified = verifyForRegistration(db, request.attestation, request.previousAttestations ?? [], { material: request.id, ownerType: owner.type, ownerId: owner.id, sha256: request.sha256, size: request.size }, actor.stationId);
  } catch (error) {
    if (error instanceof AttestationError) writeRejection(db, request, actor.memberId, error);
    throw error;
  }
  const fields: Record<string, unknown> = { [owner.type]: owner.id, path: request.path, sha256: request.sha256, size: request.size, kind: request.kind ?? null, station: verified.current.station };
  const all = [...verified.previous, verified.current];
  const details: Record<string, unknown> = { sha256: request.sha256, size: request.size, kind: request.kind ?? null, station: verified.current.station };
  if (verified.previous.length > 0) details["reattested"] = all.length;
  return createRecord(db, { type: MATERIAL_RECORD_TYPE, fields }, actor.memberId, {
    id: request.id,
    right: "material.register",
    action: "material.register",
    details,
    within: (record, at) => {
      const path = checkMaterialPath(String(record.fields["path"]));
      if (!path.ok) throw new ApiError("material_path_invalid", { rule: "empty" });
      db.prepare("INSERT INTO material_state (id, ownerType, ownerId, pathKey, delivery, currentAttestation) VALUES (?, ?, ?, ?, 'pending', ?)").run(record.id, owner.type, owner.id, path.pathKey, all.length);
      insertAttestations(db, record.id, all, at);
    },
  });
}
