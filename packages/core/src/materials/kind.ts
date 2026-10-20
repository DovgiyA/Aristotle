// Смена вида Материала (BANK-59 … BANK-63, ROLE-25; research R8 фичи 006): правило — kindChangeAction
// из protocol; перевод образа или логической копии в другой вид — только маршрутом release (Старший с
// подтверждением присутствия, STATION-12); вид «крипто-задача» ставит Секрет в той же транзакции. Вид
// меняют в черновике Кейса; Правка Подтверждённого Кейса — фича 010.
import { kindChangeAction, type BankRecord } from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";
import { inTransaction, type Db } from "../db/open.ts";
import { changeSecretInTx, getRecord, updateRecordInTx } from "../bank/records.ts";
import { currentDictionary } from "../dictionary/current.ts";
import { appliedMaterialKinds, assertDraftCase, ownerOfFields, readMaterialState } from "./type.ts";

export interface KindResult {
  record: BankRecord;
  warning?: "material_starts_leaving";
}

/** release — запрос пришёл маршрутом /kind/release (право material.kind.release проверено хуком). */
export function changeKind(db: Db, id: string, request: { expectedVersion: number; kind: string }, memberId: string, release: boolean): KindResult {
  return inTransaction(db, () => {
    const current = getRecord(db, id);
    const state = readMaterialState(db, id);
    if (current === undefined || current.type !== "material" || state === undefined) throw new ApiError("not_found", { id });
    if (state.deletedAt !== null) throw new ApiError("material_deleted");
    const owner = ownerOfFields(current.fields);
    if (owner.type === "case") assertDraftCase({ db }, owner.id);
    const from = (current.fields["kind"] as string | null | undefined) ?? null;
    const dict = currentDictionary(db);
    if (dict === undefined) throw new ApiError("dictionary_missing");
    const change = kindChangeAction(from, request.kind, owner.type, appliedMaterialKinds(dict));
    if ("error" in change) throw new ApiError(change.error, { kind: request.kind });
    if (change.action === "material.kind.release" && !release) throw new ApiError("material_kind_release");
    const updated = updateRecordInTx(db, id, { expectedVersion: request.expectedVersion, fields: { kind: request.kind } }, memberId, {
      allowFields: ["kind"],
      right: release ? "material.kind.release" : "material.kind.set",
      action: change.action,
      details: { from, to: request.kind },
    });
    let record = updated;
    // Смена на крипто-задачу ставит Секрет (BANK-62, PARSER-10, ROLE-25); с крипто-задачи — не снимает.
    if (request.kind === "crypto_task" && !updated.secret) {
      changeSecretInTx(db, updated, true, memberId, memberId, { reason: "crypto_task" });
      record = getRecord(db, id)!;
    }
    return change.action === "material.kind.release" && updated.version !== current.version ? { record, warning: change.warning } : { record };
  });
}
