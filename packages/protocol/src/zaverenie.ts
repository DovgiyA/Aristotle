// Заверение Материала — подписанное Ключом станции утверждение: эта Станция зарегистрировала Материал
// с таким SHA-256 и размером в такое-то время (STATION-29; contracts/zaverenie-v1.md фичи 006,
// research R2). Вида Материала, способа и средства снятия и Члена Группы в нём нет (STATION-32): схема
// строгая, лишнее поле — отказ. Открытый ключ Станции — внутри, поэтому подпись проверяется и тогда,
// когда Банк Станцию не знает (STATION-31, BANK-58). Группу Заверение не покидает (STATION-33).
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { taggedMessage } from "./tagged-message.ts";
import { decodeBytes, ed25519Verify, encodeBytes } from "./node/stanciya-keys.ts";
import { decodeKey } from "./key-fingerprint.ts";

export const ZAVERENIE_FORMAT = "aristotel/zaverenie/v1";

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
/** Строчные hex: SHA-256 одним видом, иначе сравнение с Записью зависело бы от регистра. */
export const SHA256_PATTERN = "^[0-9a-f]{64}$";
/** Десятичная строка без ведущих нулей: поле подписи однозначно, как бы ни читали JSON-числа. */
export const SIZE_PATTERN = "^(0|[1-9][0-9]{0,19})$";
/** RFC 3339 UTC с миллисекундами — как toISOString(). */
const AT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
/** Ключ и подпись — base64 без «=» (NET-41), как у остальных подписей протокола. */
const B64 = "^[A-Za-z0-9+/]+$";

const Strict = { additionalProperties: false } as const;

export const AttestationOwner = Type.Union([
  Type.Object({ case: Type.String({ pattern: UUID }) }, Strict),
  Type.Object({ document: Type.String({ pattern: UUID }) }, Strict),
]);
export type AttestationOwner = Static<typeof AttestationOwner>;

export const AttestationSchema = Type.Object(
  {
    format: Type.Literal(ZAVERENIE_FORMAT),
    material: Type.String({ pattern: UUID }),
    owner: AttestationOwner,
    sha256: Type.String({ pattern: SHA256_PATTERN }),
    size: Type.String({ pattern: SIZE_PATTERN }),
    station: Type.String({ pattern: UUID }),
    stationKey: Type.String({ pattern: B64 }),
    at: Type.String({ pattern: AT_PATTERN }),
    signature: Type.String({ pattern: B64 }),
  },
  Strict,
);
export type Attestation = Static<typeof AttestationSchema>;

/** Поля Заверения без подписи — то, что подписывается. */
export type AttestationFields = Omit<Attestation, "format" | "signature">;

export function ownerOf(owner: AttestationOwner): { type: "case" | "document"; id: string } {
  return "case" in owner ? { type: "case", id: owner.case } : { type: "document", id: owner.document };
}

/** Подписываемое сообщение (contracts/zaverenie-v1.md «Подписываемое сообщение»). */
export function attestationMessage(a: AttestationFields): Uint8Array {
  const owner = ownerOf(a.owner);
  return taggedMessage(ZAVERENIE_FORMAT, a.material, owner.type, owner.id, a.sha256, a.size, a.station, a.stationKey, a.at);
}

/** Подписать Заверение: signer — подпись Ключом станции (секретную часть держит Станция). */
export function signAttestation(sign: (message: Uint8Array) => Uint8Array, fields: AttestationFields): Attestation {
  return {
    format: ZAVERENIE_FORMAT,
    material: fields.material,
    owner: "case" in fields.owner ? { case: fields.owner.case } : { document: fields.owner.document },
    sha256: fields.sha256,
    size: fields.size,
    station: fields.station,
    stationKey: fields.stationKey,
    at: fields.at,
    signature: encodeBytes(sign(attestationMessage(fields))),
  };
}

/** Объект по схеме Заверения (лишние поля, вид, способ снятия — нет). */
export function isAttestation(value: unknown): value is Attestation {
  if (!Value.Check(AttestationSchema, value)) return false;
  const owner = (value as { owner: Record<string, unknown> }).owner;
  return Object.keys(owner).length === 1 && decodeKey((value as Attestation).stationKey) !== undefined;
}

/** Подпись Заверения его собственным ключом stationKey. */
export function verifyAttestationSignature(a: Attestation): boolean {
  const signature = decodeBytes(a.signature, 64);
  if (signature === undefined) return false;
  return ed25519Verify(a.stationKey, attestationMessage(a), signature);
}

export class AttestationFormatError extends Error {}

/** Файл Заверения (рядом с Материалом или на Станции): UTF-8 JSON по схеме. */
export function parseAttestationFile(text: string): Attestation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AttestationFormatError("attestation_invalid");
  }
  if (!isAttestation(parsed)) throw new AttestationFormatError("attestation_invalid");
  return parsed;
}

/** Текст файла Заверения: JSON в порядке полей схемы, «\n» в конце (contracts/zaverenie-v1.md). */
export function attestationFileText(a: Attestation): string {
  const ordered: Attestation = {
    format: a.format,
    material: a.material,
    owner: a.owner,
    sha256: a.sha256,
    size: a.size,
    station: a.station,
    stationKey: a.stationKey,
    at: a.at,
    signature: a.signature,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
