// Удаление Материала Старшим (BANK-12; research R10 фичи 006; Clarifications — путь занят навсегда):
// одной транзакцией — служебная строка истории «$deleted», версия +1, отметка в material_state, журнал
// material.delete с прежним SHA-256; после фиксации — уборка файла и всех Заверений из дерева. Не
// удалось убрать — treeCleanup = 1, служба доведёт при запуске. Полное удаление с историей — Вычистка
// (фича 015).
import { DELETED_HISTORY_FIELD, type BankRecord } from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";
import { inTransaction, type Db } from "../db/open.ts";
import { checkVersion, getRecord, writeServiceChangeInTx } from "../bank/records.ts";
import { assertActor } from "../rights/rights.ts";
import { readMaterialState } from "./type.ts";
import { removeFromTree } from "./tree.ts";

export interface DeleteFaults {
  /** Вместо уборки дерева — сбой (тест treeCleanup). */
  removeTree?: () => void;
}

export function deleteMaterial(db: Db, dataDir: string, id: string, request: { expectedVersion: number; reason: string }, memberId: string, faults: DeleteFaults = {}): BankRecord {
  const { record, owner, count } = inTransaction(db, () => {
    assertActor(db, memberId, "material.delete");
    const current = getRecord(db, id);
    const state = readMaterialState(db, id);
    if (current === undefined || current.type !== "material" || state === undefined) throw new ApiError("not_found", { id });
    if (state.deletedAt !== null) throw new ApiError("material_deleted");
    checkVersion(db, current, request.expectedVersion);
    const at = new Date().toISOString();
    const updated = writeServiceChangeInTx(db, current, DELETED_HISTORY_FIELD, { at, by: memberId, reason: request.reason }, memberId, "material.delete", {
      sha256: current.fields["sha256"],
      reason: request.reason,
    });
    db.prepare("UPDATE material_state SET deletedAt = ?, deletedBy = ?, deleteReason = ?, treeCleanup = 1 WHERE id = ?").run(at, memberId, request.reason, id);
    db.prepare("DELETE FROM material_upload WHERE materialId = ?").run(id);
    return { record: updated, owner: { type: state.ownerType, id: state.ownerId }, count: state.currentAttestation };
  });
  try {
    if (faults.removeTree !== undefined) faults.removeTree();
    removeFromTree(dataDir, id, owner, String(record.fields["path"]), count);
    inTransaction(db, () => db.prepare("UPDATE material_state SET treeCleanup = 0 WHERE id = ?").run(id));
  } catch {
    // Уборку доведёт reconcileMaterials при запуске службы (research R10).
  }
  return record;
}
