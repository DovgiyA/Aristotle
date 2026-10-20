// Подписанный документ: тело — JSON-текст строкой, подписи Ed25519 отдельно; подписывается
// UTF-8(format) ‖ 0x00 ‖ UTF-8(body). Тело хранится и пересылается байт в байт, канонизация JSON не
// нужна. Общий модуль: версии Реестра (фича 003), Словаря Сети (005), распоряжения (019), подписи
// кворума (NET-50) — тот же массив signatures (research R5 фичи 003; contracts/reestr-v1.md).
import { createHash, createPublicKey, verify } from "node:crypto";
import { decodeKey } from "./key-fingerprint.ts";

export interface Signature {
  key: string;
  sig: string;
}

export interface SignedDocument {
  format: string;
  body: string;
  signatures: Signature[];
}

/** Предел тела документа по умолчанию — 1 МиБ в UTF-8 (Реестр). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Предел тела версии Словаря Сети — 64 МиБ: Стоп-лист едет в версии целиком (DICT-46; research R4 фичи 005). */
export const SLOVAR_MAX_BODY_BYTES = 64 * 1024 * 1024;

const SIG_TEXT = /^[A-Za-z0-9+/]{86}$/;

/** Документ не по формату: reason — для ответа API (registry_rejected, reason: format). */
export class SignedDocumentError extends Error {
  readonly reason = "format";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

function decodeSig(text: string): Uint8Array | undefined {
  if (!SIG_TEXT.test(text)) return undefined;
  const raw = Buffer.from(text, "base64");
  return raw.length === 64 && raw.toString("base64").replace(/=+$/, "") === text ? new Uint8Array(raw) : undefined;
}

/** Разобрать документ ожидаемого формата; любое отступление — SignedDocumentError. Предел тела задаёт формат. */
export function parseSignedDocument(text: string, format: string, options: { maxBodyBytes?: number } = {}): SignedDocument {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SignedDocumentError("document is not JSON");
  }
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["format", "body", "signatures"])) {
    throw new SignedDocumentError("document fields");
  }
  if (value["format"] !== format) throw new SignedDocumentError("format");
  const body = value["body"];
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > maxBodyBytes) throw new SignedDocumentError("body");
  const raw = value["signatures"];
  if (!Array.isArray(raw)) throw new SignedDocumentError("signatures");
  const signatures: Signature[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isPlainObject(item) || !hasOnlyKeys(item, ["key", "sig"])) throw new SignedDocumentError("signature fields");
    const { key, sig } = item;
    if (typeof key !== "string" || decodeKey(key) === undefined) throw new SignedDocumentError("signature key");
    if (typeof sig !== "string" || decodeSig(sig) === undefined) throw new SignedDocumentError("signature value");
    if (seen.has(key)) throw new SignedDocumentError("signature key repeated");
    seen.add(key);
    signatures.push({ key, sig });
  }
  return { format, body, signatures };
}

/** Документ в текст для файла и API. */
export function serializeSignedDocument(doc: SignedDocument): string {
  return JSON.stringify({ format: doc.format, body: doc.body, signatures: doc.signatures }, null, 2) + "\n";
}

/** Подписываемое сообщение: UTF-8(format) ‖ 0x00 ‖ UTF-8(body). */
export function signingMessage(format: string, body: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(format, "utf8"), Buffer.from([0]), Buffer.from(body, "utf8")]));
}

/** Добавить подпись: ключ — открытая часть, подписывает переданная функция (секрета модуль не видит). */
export function addSignature(doc: SignedDocument, publicKey: string, sign: (message: Uint8Array) => Uint8Array): SignedDocument {
  if (decodeKey(publicKey) === undefined) throw new SignedDocumentError("signature key");
  const sig = Buffer.from(sign(signingMessage(doc.format, doc.body))).toString("base64").replace(/=+$/, "");
  const signatures = doc.signatures.filter((s) => s.key !== publicKey);
  return { ...doc, signatures: [...signatures, { key: publicKey, sig }] };
}

/** Открытый ключ Ed25519 из 32 байт — объект node:crypto. */
export function ed25519PublicKey(publicKey: string) {
  const raw = decodeKey(publicKey);
  if (raw === undefined) throw new SignedDocumentError("signature key");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

/** Проверить подпись документа данным ключом; подписи этим ключом нет — false. */
export function verifySignature(doc: SignedDocument, publicKey: string): boolean {
  const entry = doc.signatures.find((s) => s.key === publicKey);
  if (entry === undefined) return false;
  const sig = decodeSig(entry.sig);
  if (sig === undefined) return false;
  try {
    return verify(null, signingMessage(doc.format, doc.body), ed25519PublicKey(publicKey), sig);
  } catch {
    return false;
  }
}

/** Тождество версии документа — SHA-256 от UTF-8(body), hex строчными. */
export function bodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
