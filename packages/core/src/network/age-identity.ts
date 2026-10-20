// Идентичность age X25519 без асинхронных вызовов: пара из node:crypto, кодировка bech32 (BIP 173) —
// `AGE-SECRET-KEY-1…` и `age1…`, как у age-encryption (typage). Нужна, чтобы создание Ключа Группы
// шло одним синхронным участком внутри BEGIN IMMEDIATE (T069 фичи 003; research R1, R3).
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const IDENTITY_HRP = "age-secret-key-";
const RECIPIENT_HRP = "age";
// PKCS#8 для X25519: префикс DER перед 32 байтами секретного ключа (RFC 8410).
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
}

function convertBits(data: Uint8Array | number[], from: number, to: number, pad: boolean): number[] | undefined {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max) !== 0) {
    return undefined;
  }
  return out;
}

/** Закодировать байты в bech32 строчными буквами. */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true)!;
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

/** Разобрать bech32 (в одном регистре); неверная контрольная сумма или знак — undefined. */
export function bech32Decode(text: string): { hrp: string; bytes: Uint8Array } | undefined {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return undefined;
  const lower = text.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return undefined;
  const hrp = lower.slice(0, sep);
  const data: number[] = [];
  for (const c of lower.slice(sep + 1)) {
    const value = CHARSET.indexOf(c);
    if (value === -1) return undefined;
    data.push(value);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return undefined;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  return bytes === undefined ? undefined : { hrp, bytes: new Uint8Array(bytes) };
}

/** Новая идентичность age X25519 и её строка получателя. */
export function generateAgeIdentity(): { identity: string; recipient: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const d = Buffer.from((privateKey.export({ format: "jwk" }) as { d: string }).d, "base64url");
  const x = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  return { identity: bech32Encode(IDENTITY_HRP, d).toUpperCase(), recipient: bech32Encode(RECIPIENT_HRP, x) };
}

/** Строка получателя `age1…` по идентичности `AGE-SECRET-KEY-1…`; не идентичность — undefined. */
export function ageRecipientOf(identity: string): string | undefined {
  if (!identity.startsWith("AGE-SECRET-KEY-1")) return undefined;
  const decoded = bech32Decode(identity);
  if (decoded === undefined || decoded.hrp !== IDENTITY_HRP || decoded.bytes.length !== 32) return undefined;
  const privateKey = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, decoded.bytes]), format: "der", type: "pkcs8" });
  const x = Buffer.from((createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x, "base64url");
  return bech32Encode(RECIPIENT_HRP, x);
}
