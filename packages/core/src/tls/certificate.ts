// Самоподписанный сертификат X.509 v3 на ключе Ed25519: субъект и издатель CN=aristotel, срок 10 лет,
// без расширений. В node:crypto нет создания сертификатов, а структура одна и неизменна, поэтому DER
// собирается здесь (research R2 фичи 004); доверие держится на ключе — отпечаток SPKI (RELAY-16,
// STATION-40), даты клиенты не проверяют.
import { createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const ED25519 = sequence(Buffer.from("06032b6570", "hex")); // AlgorithmIdentifier, OID 1.3.101.112
const NAME = sequence(tlv(0x31, sequence(Buffer.from("0603550403", "hex"), tlv(0x0c, Buffer.from("aristotel")))));

function generalizedTime(date: Date): Buffer {
  return tlv(0x18, Buffer.from(date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"));
}

/** PEM самоподписанного сертификата на ключе Ed25519. */
export function selfSignedCertificate(privateKey: KeyObject, now: Date = new Date()): string {
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const serial = randomBytes(16);
  // INTEGER положительный и минимальный: старший бит 0, первый байт не 0 — иначе OpenSSL отвергает
  // сертификат («illegal padding»), когда за нулём идёт байт меньше 0x80.
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(now.getUTCFullYear() + 10);
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // версия v3
    tlv(0x02, serial),
    ED25519,
    NAME,
    sequence(generalizedTime(now), generalizedTime(notAfter)),
    NAME,
    spki,
  );
  const signature = sign(null, tbs, privateKey);
  const der = sequence(tbs, ED25519, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
