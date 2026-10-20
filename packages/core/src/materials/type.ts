// Тип Записи «Запись о Материале» (BANK-10, BANK-13, BANK-59; research R3 фичи 006; data-model.md
// «Запись о Материале»): Кейс или Документ, путь, SHA-256, размер, вид, Станция регистрации. Поля,
// кроме вида, не меняются; правку общим маршрутом /api/records тип отвергает — вид меняют маршруты
// Материала (research R8). Состояние доставки, удаления и Заверения — в таблицах material_* (R11):
// это не поля, которые правит человек.
import { Type } from "typebox";
import {
  MATERIAL_RECORD_TYPE,
  SHA256_PATTERN,
  SIZE_PATTERN,
  checkMaterialPath,
  kindChangeAction,
  type AttestationMark,
  type BankRecord,
  type MaterialView,
} from "@aristotel/protocol";
import { registerRecordType, type RecordContext, type RecordType } from "../bank/record-types.ts";
import { ApiError } from "../api/errors.ts";
import type { Db } from "../db/open.ts";
import type { AppliedDictionary } from "../dictionary/current.ts";
import { recordLabel } from "../model/labels.ts";
import { Issues, recordFields, recordTypeOf, requireDictionary } from "../model/validate.ts";

type Fields = Record<string, unknown>;
const Strict = { additionalProperties: false } as const;

const MaterialFields = Type.Object(
  {
    case: Type.Optional(Type.String({ minLength: 1 })),
    document: Type.Optional(Type.String({ minLength: 1 })),
    path: Type.String({ minLength: 1 }),
    sha256: Type.String({ pattern: SHA256_PATTERN }),
    size: Type.String({ pattern: SIZE_PATTERN }),
    // Код вида из закрытого перечня material_kind; null — вида ещё нет (Clarifications 2026-10-20).
    kind: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    station: Type.String({ minLength: 1 }),
  },
  Strict,
);

/**
 * Путь занят: тот же путь, путь-каталог над ним или под ним — в том числе у удалённого Материала
 * (BANK-11; Clarifications). Иначе файл одного Материала лёг бы на место каталога другого.
 */
export function pathConflict(db: Db, owner: { type: string; id: string }, pathKey: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS x FROM material_state WHERE ownerType = ? AND ownerId = ? AND (pathKey = ? OR substr(pathKey, 1, length(?) + 1) = ? || '/' OR substr(?, 1, length(pathKey) + 1) = pathKey || '/') LIMIT 1",
      )
      .get(owner.type, owner.id, pathKey, pathKey, pathKey, pathKey) !== undefined
  );
}

/** Материал когда-либо был крипто-задачей — Секрет с него не снимается никем (BANK-62, ROLE-18, SC-007). */
export function everCryptoTask(db: Db, id: string): boolean {
  return db.prepare("SELECT 1 AS x FROM record_history WHERE recordId = ? AND field = 'kind' AND after = '\"crypto_task\"' LIMIT 1").get(id) !== undefined;
}

/** Поля, которые не меняются никогда (BANK-11, BANK-13, STATION-29). */
const IMMUTABLE = ["case", "document", "path", "sha256", "size", "station"] as const;

/** Коды перечня material_kind применённого Словаря Сети (BANK-63). */
export function appliedMaterialKinds(dict: AppliedDictionary): string[] {
  const en = dict.byCode("enum", "material_kind");
  return en === undefined ? [] : dict.enumValues(en.id).map((el) => el.code);
}

export function ownerOfFields(fields: Fields): { type: "case" | "document"; id: string } {
  return typeof fields["case"] === "string" ? { type: "case", id: fields["case"] } : { type: "document", id: String(fields["document"]) };
}

/** Кейс в Черновике: регистрация и вид — только в черновике; Правка — фича 010. */
export function assertDraftCase(ctx: { db: Db }, caseId: string): void {
  const fields = recordFields({ db: ctx.db } as RecordContext, caseId);
  if (fields === undefined) throw new ApiError("not_found", { id: caseId });
  if (fields["status"] !== "draft") throw new ApiError("case_not_draft");
}

function prepare(ctx: RecordContext, input: Fields, previous?: BankRecord): { fields: Fields; secret?: boolean } {
  const dict = requireDictionary(ctx);
  const fields: Fields = { ...input };
  if (previous !== undefined) {
    // Общий маршрут правки — отказ; маршрут Материала меняет только разрешённые поля (research R3).
    if (ctx.allowFields === undefined) throw new ApiError("material_use_material_routes");
    for (const name of [...IMMUTABLE, "kind"]) {
      if (ctx.allowFields.includes(name)) continue;
      if ((fields[name] ?? null) !== (previous.fields[name] ?? null)) throw new ApiError("material_use_material_routes");
    }
    return { fields };
  }
  // Запись о Материале заводит только регистрация с Заверением (BANK-17, STATION-31), не общий маршрут.
  if (ctx.purpose !== "material.register") throw new ApiError("material_use_material_routes");
  const issues = new Issues();
  const hasCase = typeof fields["case"] === "string";
  const hasDocument = typeof fields["document"] === "string";
  if (hasCase === hasDocument) issues.add(hasCase ? "document" : "case", "field", "owner");
  if (hasDocument && recordTypeOf(ctx, fields["document"]) !== "document") issues.add("document", "kind");
  if (hasCase && recordTypeOf(ctx, fields["case"]) !== "case") issues.add("case", "kind");
  issues.throwIfAny();
  const owner = ownerOfFields(fields);
  if (owner.type === "case") assertDraftCase(ctx, owner.id);
  const path = checkMaterialPath(String(fields["path"]));
  if (!path.ok) throw path.code === "material_path_reserved" ? new ApiError("material_path_reserved") : new ApiError("material_path_invalid", { rule: path.rule }, { rule: path.rule });
  if (pathConflict(ctx.db, owner, path.pathKey)) throw new ApiError("material_path_taken", { path: String(fields["path"]) });
  fields["kind"] ??= null;
  if (fields["kind"] !== null) {
    const change = kindChangeAction(null, String(fields["kind"]), owner.type, appliedMaterialKinds(dict));
    if ("error" in change) throw new ApiError(change.error, { kind: String(fields["kind"]) });
  }
  // Крипто-задача — Секрет с создания: у Наблюдателя её не бывает и мгновения (BANK-62, ROLE-25).
  return { fields, secret: fields["kind"] === "crypto_task" };
}

/** Состояние Материала из material_state (data-model.md «material_state»). */
export interface MaterialState {
  ownerType: "case" | "document";
  ownerId: string;
  pathKey: string;
  delivery: "pending" | "delivered";
  deliveredAt: string | null;
  deliveredByStation: string | null;
  currentAttestation: number;
  deletedAt: string | null;
  deletedBy: string | null;
  deleteReason: string | null;
  treeCleanup: boolean;
}

export function readMaterialState(db: Db, id: string): MaterialState | undefined {
  const r = db.prepare("SELECT * FROM material_state WHERE id = ?").get(id);
  if (r === undefined) return undefined;
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    ownerType: String(r["ownerType"]) as "case" | "document",
    ownerId: String(r["ownerId"]),
    pathKey: String(r["pathKey"]),
    delivery: String(r["delivery"]) as "pending" | "delivered",
    deliveredAt: text(r["deliveredAt"]),
    deliveredByStation: text(r["deliveredByStation"]),
    currentAttestation: Number(r["currentAttestation"]),
    deletedAt: text(r["deletedAt"]),
    deletedBy: text(r["deletedBy"]),
    deleteReason: text(r["deleteReason"]),
    treeCleanup: Number(r["treeCleanup"]) === 1,
  };
}

/** Пометка Заверения по состоянию Станции сейчас, а не навсегда (STATION-31; Assumptions spec.md). */
export function attestationMark(db: Db, stationId: string, stationKey: string): AttestationMark {
  const row = db.prepare("SELECT publicKey, state FROM station WHERE id = ?").get(stationId);
  if (row === undefined || String(row["publicKey"]) !== stationKey) return "station_unknown";
  return String(row["state"]) === "active" ? null : "station_revoked";
}

export function materialView(db: Db, dict: AppliedDictionary | undefined, record: BankRecord): MaterialView {
  const state = readMaterialState(db, record.id);
  const attestations = db
    .prepare("SELECT n, json, stationId, stationKey FROM material_attestation WHERE materialId = ? ORDER BY n")
    .all(record.id)
    .map((r) => {
      const json = JSON.parse(String(r["json"])) as { at?: string };
      const n = Number(r["n"]);
      return { n, station: String(r["stationId"]), at: String(json.at ?? ""), current: n === state?.currentAttestation, mark: attestationMark(db, String(r["stationId"]), String(r["stationKey"])) };
    });
  const incomplete: MaterialView["incomplete"] = [];
  if (record.fields["kind"] === null || record.fields["kind"] === undefined) incomplete.push("kind");
  if (typeof record.fields["sha256"] !== "string") incomplete.push("sha256");
  return {
    label: recordLabel(db, dict, record.id),
    delivery: state?.delivery ?? "pending",
    deliveredAt: state?.deliveredAt ?? null,
    deliveredByStation: state?.deliveredByStation ?? null,
    deleted: state?.deletedAt === null || state === undefined ? null : { at: state.deletedAt, by: state.deletedBy ?? "", reason: state.deleteReason ?? "" },
    attestations,
    incomplete,
  };
}

export const materialType: RecordType = {
  name: MATERIAL_RECORD_TYPE,
  fields: MaterialFields,
  indexText: (f) => String(f["path"] ?? ""),
  prepare,
  // Материал Кейса относится к Кейсу (INBOX-32, DATA-36); Документ — фича 013.
  derive: (ctx, record) => {
    if (typeof record.fields["case"] === "string") ctx.db.prepare("INSERT OR REPLACE INTO record_case (recordId, caseId) VALUES (?, ?)").run(record.id, record.fields["case"]);
  },
  caseOf: (_ctx, record) => (typeof record.fields["case"] === "string" ? record.fields["case"] : null),
  secretLocked: (record, db) => record.fields["kind"] === "crypto_task" || everCryptoTask(db, record.id),
  view: (ctx, record) => materialView(ctx.db, ctx.dictionary, record) as unknown as Record<string, unknown>,
};

export function registerMaterialType(): void {
  registerRecordType(materialType);
}
