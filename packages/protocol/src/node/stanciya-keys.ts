// Ключи Ed25519 на Node: из семени, открытая часть в кодировке NET-41, подпись и проверка; вывод
// ключа Прохода и ключа приёма из секрета Приглашения — HKDF-SHA256 (contracts/stanciya-v1.md,
// research R7 фичи 004). Модули protocol/src/node/ интерфейс не импортирует: в браузерную сборку
// они не попадают.
import { createHash, createPrivateKey, createPublicKey, hkdfSync, sign, verify, type KeyObject } from "node:crypto";
import { decodeKey, encodeKey } from "../key-fingerprint.ts";
import { INVITATION_INFO_ACCEPT, INVITATION_INFO_PASSAGE } from "../stanciya.ts";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Секретный ключ Ed25519 из 32 байт семени. */
export function ed25519FromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("ed25519FromSeed: seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** Открытый ключ Ed25519 в кодировке NET-41 (32 байта, base64 без «=»). */
export function publicKeyText(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x: string };
  return encodeKey(Buffer.from(jwk.x, "base64url"));
}

export function ed25519Sign(key: KeyObject, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, message, key));
}

/** Проверить подпись открытым ключом в кодировке NET-41; неверный ключ или подпись — false. */
export function ed25519Verify(publicKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  const raw = decodeKey(publicKey);
  if (raw === undefined || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** base64 без «=» ↔ байты для полей протокола (вызовы, подписи, секреты). */
export function encodeBytes(raw: Uint8Array): string {
  return Buffer.from(raw).toString("base64").replace(/=+$/, "");
}

export function decodeBytes(text: string, length?: number): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*$/.test(text)) return undefined;
  const raw = Buffer.from(text, "base64");
  if (encodeBytes(raw) !== text) return undefined;
  if (length !== undefined && raw.length !== length) return undefined;
  return new Uint8Array(raw);
}

function hkdf(secret: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), info, 32));
}

export interface InvitationKeys {
  /** Секретный ключ Прохода: им Станция подписывает вызов Прохода (STATION-04). */
  passagePrivateKey: KeyObject;
  /** Открытый ключ Прохода — в перечень Прохода и в БД (data-model.md «invitation»). */
  passageKey: string;
  /** Ключ приёма — Станция предъявляет его Опорной станции внутри TLS. */
  acceptKey: Uint8Array;
}

/** Вывести ключ Прохода и ключ приёма из секрета Приглашения (research R7). */
export function deriveInvitationKeys(secret: Uint8Array): InvitationKeys {
  if (secret.length !== 32) throw new Error("deriveInvitationKeys: secret must be 32 bytes");
  const passagePrivateKey = ed25519FromSeed(hkdf(secret, INVITATION_INFO_PASSAGE));
  return { passagePrivateKey, passageKey: publicKeyText(passagePrivateKey), acceptKey: hkdf(secret, INVITATION_INFO_ACCEPT) };
}

/** SHA-256 ключа приёма в hex — то, что хранит Опорная станция. */
export function acceptKeyHash(acceptKey: Uint8Array): string {
  return createHash("sha256").update(acceptKey).digest("hex");
}

/** SHA-256 текста в hex строчными (тело подтверждения присутствия). */
export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}
