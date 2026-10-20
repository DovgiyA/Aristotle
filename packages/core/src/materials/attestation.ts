// Проверка Заверения на Опорной станции (STATION-31; research R5 фичи 006; contracts/zaverenie-v1.md
// «Проверка»): по порядку — схема, подпись, совпадение с Записью, ключ Станции, Станция известна и
// действует. Первая неудача — причина отказа. Повторное Заверение: новое — от действующей Станции
// загружающего Члена Группы, прежние — от отозванной или неизвестной Банку Станции.
import { isAttestation, ownerOf, verifyAttestationSignature, type Attestation, type ErrorCode } from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";
import type { Db } from "../db/open.ts";

/** Что Заверение обязано утверждать — поля Записи о Материале. */
export interface AttestedFacts {
  material: string;
  ownerType: "case" | "document";
  ownerId: string;
  sha256: string;
  size: string;
}

export class AttestationError extends ApiError {
  readonly station: string | undefined;
  constructor(code: ErrorCode, params: Record<string, string> = {}, station?: string) {
    super(code, params, station === undefined ? {} : { station });
    this.station = station;
  }
}

/** Схема, подпись и совпадение с фактами Записи; станцию не смотрит. */
export function checkAttestationShape(value: unknown, facts: AttestedFacts): Attestation {
  if (!isAttestation(value)) throw new AttestationError("attestation_invalid");
  if (!verifyAttestationSignature(value)) throw new AttestationError("attestation_signature", {}, value.station);
  const owner = ownerOf(value.owner);
  const mismatch =
    value.material !== facts.material
      ? "material"
      : owner.type !== facts.ownerType || owner.id !== facts.ownerId
        ? "owner"
        : value.sha256 !== facts.sha256
          ? "sha256"
          : value.size !== facts.size
            ? "size"
            : undefined;
  if (mismatch !== undefined) throw new AttestationError("attestation_mismatch", { field: mismatch }, value.station);
  return value;
}

export type StationStateOfKey = "active" | "revoked" | "unknown";

/** Станция Заверения в Банке: её ключ обязан совпасть с ключом в Заверении. */
export function stationOfAttestation(db: Db, a: Attestation): StationStateOfKey {
  const row = db.prepare("SELECT publicKey, state FROM station WHERE id = ?").get(a.station);
  if (row === undefined) return "unknown";
  if (String(row["publicKey"]) !== a.stationKey) throw new AttestationError("attestation_key_mismatch", { station: a.station }, a.station);
  return String(row["state"]) === "active" ? "active" : "revoked";
}

/**
 * Проверить Заверение (и прежние при повторном Заверении) для заведения Записи. sessionStation —
 * Станция сеанса запроса: новое Заверение подписано ею (Заверение — от загружающего).
 */
export function verifyForRegistration(db: Db, attestation: unknown, previous: unknown[], facts: AttestedFacts, sessionStation: string | null): { current: Attestation; previous: Attestation[] } {
  const current = checkAttestationShape(attestation, facts);
  const state = stationOfAttestation(db, current);
  if (state === "unknown") throw new AttestationError("attestation_station_unknown", { station: current.station }, current.station);
  if (state === "revoked") throw new AttestationError("attestation_station_revoked", { station: current.station }, current.station);
  if (sessionStation !== null && current.station !== sessionStation) throw new AttestationError("attestation_session_station", {}, current.station);
  const earlier: Attestation[] = [];
  for (const value of previous) {
    const a = checkAttestationShape(value, facts);
    // Повторное Заверение нужно, только если прежняя Станция отозвана или неизвестна Банку (STATION-31).
    if (stationOfAttestation(db, a) === "active") throw new AttestationError("attestation_previous_valid", { station: a.station }, a.station);
    earlier.push(a);
  }
  return { current, previous: earlier };
}
