// Кодировка открытых ключей и отпечатки: ключ Ed25519 — 32 байта в base64 RFC 4648 §4 без «=»
// (NET-41); отпечаток ключа подписи для сверки вне Сети — первые 128 бит SHA-256 восемью группами по
// 4 знака hex (NET-42); отпечаток TLS-сертификата Ретранслятора — SHA-256 от SPKI в DER (RELAY-16).
// Отпечаток с заглавной — другое понятие (значение Индикатора, раздел 8.2): здесь только
// отпечатки ключей, в коде — keyFingerprint (data-model.md фичи 003, research R4).
import { createHash, X509Certificate } from "node:crypto";

const KEY_TEXT = /^[A-Za-z0-9+/]{43}$/;

/** 32 байта → base64 без «=». */
export function encodeKey(raw: Uint8Array): string {
  return Buffer.from(raw).toString("base64").replace(/=+$/, "");
}

/** base64 без «=» → 32 байта; неканоническая запись или другая длина — undefined. */
export function decodeKey(text: string): Uint8Array | undefined {
  if (!KEY_TEXT.test(text)) return undefined;
  const raw = Buffer.from(text, "base64");
  if (raw.length !== 32 || encodeKey(raw) !== text) return undefined;
  return new Uint8Array(raw);
}

/** Отпечаток ключа подписи (NET-42): «a1b2 c3d4 … 8f90». */
export function keyFingerprint(publicKey: string): string {
  const raw = decodeKey(publicKey);
  if (raw === undefined) throw new Error("keyFingerprint: not a key");
  const hex = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return hex.match(/.{4}/g)!.join(" ");
}

/** Отпечаток TLS-сертификата (RELAY-16): SHA-256 от SubjectPublicKeyInfo в DER, base64 без «=». */
export function spkiFingerprint(certificatePem: string): string {
  const spki = new X509Certificate(certificatePem).publicKey.export({ type: "spki", format: "der" });
  return encodeKey(createHash("sha256").update(spki).digest());
}

/** Отпечаток TLS (RELAY-16, STATION-40) для сверки голосом: первые 128 бит восемью группами hex, как NET-42. */
export function tlsSpkiGroups(tlsSpki: string): string {
  const raw = decodeKey(tlsSpki);
  if (raw === undefined) throw new Error("tlsSpkiGroups: not a fingerprint");
  return Buffer.from(raw).toString("hex").slice(0, 32).match(/.{4}/g)!.join(" ");
}
