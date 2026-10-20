// Регистрация Материала на Станции (BANK-17, STATION-29; research R1, R5 фичи 006;
// contracts/lokalnaya-chast.md): копия с SHA-256, Заверение Ключом станции, Запись на Опорной станции до
// доставки файла. Без связи — Материал и Заверение остаются на Станции, Запись заведёт офлайн-черновик
// (фича 009). Повторное Заверение: Станция пересчитывает хэш и размер по файлу у себя (Clarifications).
import { basename } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { checkMaterialPath, kindChangeAction, signAttestation, type Attestation, type ErrorCode } from "@aristotel/protocol";
import { StationDeletedError, StationLockedError, type LocalPart } from "../local-part.ts";
import { readStationState } from "../station-files.ts";
import { existsSync } from "node:fs";
import { checkSourceFile, copyWithHash, materialCopyPath, promoteMaterialCopy, removeMaterialCopy, writeAttestationFile } from "./store.ts";

export interface RegisterInput {
  file: string;
  case: string;
  path?: string;
  kind?: string | null;
}

export type RegisterOutcome =
  | { status: 201; id: string; sha256: string; size: string; record: Record<string, unknown> }
  | { status: 202; id: string; sha256: string; size: string; record: null }
  | { status: number; error: ErrorCode; params?: Record<string, string>; body?: Record<string, unknown> };

/** Отказ до любой работы с файлом: путь и вид, которые Опорная станция всё равно отвергнет. */
export function precheck(input: RegisterInput): { error: ErrorCode; params?: Record<string, string> } | undefined {
  const path = input.path ?? basename(input.file);
  const checked = checkMaterialPath(path);
  if (!checked.ok) return checked.code === "material_path_reserved" ? { error: "material_path_reserved" } : { error: "material_path_invalid", params: { rule: checked.rule } };
  if (input.kind !== undefined && input.kind !== null) {
    const change = kindChangeAction(null, input.kind, "case");
    if ("error" in change) return { error: change.error, params: { kind: input.kind } };
  }
  return undefined;
}

async function submit(
  part: LocalPart,
  dataDir: string,
  body: Record<string, unknown>,
  id: string,
  sha256: string,
  size: string,
  cleanup = true,
): Promise<RegisterOutcome> {
  let res;
  try {
    res = await part.request("POST", "/api/materials", { body });
  } catch (error) {
    if (error instanceof StationLockedError || error instanceof StationDeletedError) throw error;
    // Нет связи — Материал и Заверение остаются на Станции (BANK-21, фича 009).
    return { status: 202, id, sha256, size, record: null };
  }
  if (res.status === 201) return { status: 201, id, sha256, size, record: res.json() };
  if (cleanup) removeMaterialCopy(dataDir, id);
  const json = res.text === "" ? {} : res.json();
  return { status: res.status, error: String(json["error"] ?? "internal_error") as ErrorCode, body: json };
}

/**
 * При связи — права и статус Кейса до копирования (T083): Наблюдатель и Кейс не в Черновике получают
 * отказ, не дожидаясь копирования образа в сотни ГиБ. Без связи — undefined: решит Опорная станция.
 */
async function precheckOnline(part: LocalPart, caseId: string): Promise<{ status: number; error: ErrorCode; body?: Record<string, unknown> } | undefined> {
  if (part.session?.role === "observer") return { status: 403, error: "forbidden" };
  let res;
  try {
    res = await part.request("GET", `/api/records/${encodeURIComponent(caseId)}`);
  } catch (error) {
    if (error instanceof StationLockedError || error instanceof StationDeletedError) throw error;
    return undefined;
  }
  if (res.status !== 200) {
    const body = res.text === "" ? {} : res.json();
    return { status: res.status, error: String(body["error"] ?? "not_found") as ErrorCode, body };
  }
  const record = res.json() as { type?: string; fields?: { status?: string } };
  if (record.type !== "case") return { status: 404, error: "not_found" };
  if (record.fields?.status !== "draft") return { status: 409, error: "case_not_draft" };
  return undefined;
}

export async function registerOnStation(part: LocalPart, input: RegisterInput): Promise<RegisterOutcome> {
  const refused = precheck(input);
  if (refused !== undefined) return { status: 0, ...refused };
  const key = part.stationKey;
  if (key === undefined) return { status: 423, error: "station_locked" };
  checkSourceFile(input.file);
  const early = await precheckOnline(part, input.case);
  if (early !== undefined) return early;
  const station = readStationState(part.dataDir);
  const id = randomUUIDv7();
  const copy = await copyWithHash(part.dataDir, input.file, id);
  const size = String(copy.size);
  const attestation = signAttestation(key.sign, { material: id, owner: { case: input.case }, sha256: copy.sha256, size, station: station.stationId, stationKey: key.publicKey, at: new Date().toISOString() });
  writeAttestationFile(part.dataDir, attestation);
  const body: Record<string, unknown> = { id, owner: { case: input.case }, path: input.path ?? basename(input.file), sha256: copy.sha256, size, attestation };
  if (input.kind !== undefined) body["kind"] = input.kind;
  return await submit(part, part.dataDir, body, id, copy.sha256, size);
}

/**
 * Повторное Заверение Материала отозванной или неизвестной Банку Станции (STATION-31): копия файла под
 * Идентификатором из прежнего Заверения с пересчётом SHA-256 и размера; расхождение — отказ, копия
 * удаляется; совпало — новое Заверение этой Станцией и Запись с прежним.
 */
export async function reattestOnStation(part: LocalPart, input: RegisterInput & { previous: Attestation }): Promise<RegisterOutcome> {
  const refused = precheck(input);
  if (refused !== undefined) return { status: 0, ...refused };
  const key = part.stationKey;
  if (key === undefined) return { status: 423, error: "station_locked" };
  checkSourceFile(input.file);
  const station = readStationState(part.dataDir);
  const id = input.previous.material;
  // Своя копия этого Материала уже есть — новая и её Заверение ждут ответа 201 под временным именем,
  // при отказе удаляются только они (T096).
  const name = existsSync(materialCopyPath(part.dataDir, id)) ? `${id}.reattest` : id;
  // Копия заменяет прежнюю, только если сошлась с прежним Заверением (T093).
  const copy = await copyWithHash(part.dataDir, input.file, id, (sha256, size) => sha256 === input.previous.sha256 && String(size) === input.previous.size, name);
  const size = String(copy.size);
  const attestation = signAttestation(key.sign, { material: id, owner: input.previous.owner, sha256: copy.sha256, size, station: station.stationId, stationKey: key.publicKey, at: new Date().toISOString() });
  const body: Record<string, unknown> = { id, owner: input.previous.owner, path: input.path ?? basename(input.file), sha256: copy.sha256, size, attestation, previousAttestations: [input.previous] };
  if (input.kind !== undefined) body["kind"] = input.kind;
  if (!copy.placed) {
    // Расхождение: при связи отказ даёт и пишет в журнал Опорная станция (T081), без связи — Станция;
    // ни копия, ни Заверение на Станции не меняются.
    const outcome = await submit(part, part.dataDir, body, id, copy.sha256, size, false);
    if (outcome.status === 202 || outcome.status === 201) return { status: 422, error: "attestation_mismatch", params: { field: copy.sha256 !== input.previous.sha256 ? "sha256" : "size" } };
    return outcome;
  }
  writeAttestationFile(part.dataDir, attestation, name);
  const outcome = await submit(part, part.dataDir, body, id, copy.sha256, size, name === id);
  if (name !== id) {
    if (outcome.status === 201) promoteMaterialCopy(part.dataDir, name, id);
    else removeMaterialCopy(part.dataDir, name);
  }
  return outcome;
}

export type AttachOutcome = { status: 202; id: string; size: string } | { status: number; error: ErrorCode; params?: Record<string, string>; body?: Record<string, unknown> };

/**
 * Доставка Материала, зарегистрированного на другой Станции (FR-008a, T078): копия файла с SHA-256 под
 * Идентификатором Материала, сверка с Записью Опорной станции, очередь. Заверение не переподписывается.
 */
export async function attachOnStation(part: LocalPart, id: string, file: string): Promise<AttachOutcome> {
  if (part.stationKey === undefined) return { status: 423, error: "station_locked" };
  checkSourceFile(file);
  let res;
  try {
    res = await part.request("GET", `/api/materials/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof StationLockedError || error instanceof StationDeletedError) throw error;
    return { status: 503, error: "offline", params: { since: part.state().offlineSince ?? "" } };
  }
  if (res.status !== 200) {
    const body = res.text === "" ? {} : res.json();
    return { status: res.status, error: String(body["error"] ?? "not_found") as ErrorCode, body };
  }
  const record = res.json() as { fields: { sha256?: string; size?: string }; view?: { delivery?: string; deleted?: unknown } };
  if (record.view?.deleted !== null && record.view?.deleted !== undefined) return { status: 409, error: "material_deleted" };
  if (record.view?.delivery === "delivered") return { status: 409, error: "delivery_done" };
  // Сверка с Записью до замены: при расхождении копия и Заверение Станции не трогаются (T093).
  const copy = await copyWithHash(part.dataDir, file, id, (sha256, size) => sha256 === record.fields.sha256 && String(size) === record.fields.size);
  if (!copy.placed) return { status: 422, error: "delivery_hash_mismatch" };
  return { status: 202, id, size: String(copy.size) };
}

