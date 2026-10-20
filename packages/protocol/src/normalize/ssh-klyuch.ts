// «ssh-ключ» — SHA-256 от блоба открытого ключа (RFC 4253), base64 без «=»; у отпечатка SHA256: снят
// префикс (DICT-34).
import { fail, ok, trimSpace, type NormResult } from "./common.ts";
import { sha256 } from "./sha256.ts";

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FINGERPRINT = /^SHA256:([A-Za-z0-9+/]{43})$/;

function decodeBase64(text: string): Uint8Array | undefined {
  if (!B64.test(text) || text.length % 4 !== 0) return undefined;
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

export function sshKlyuch(input: string): NormResult {
  const s = trimSpace(input);
  const fp = FINGERPRINT.exec(s);
  if (fp !== null) return ok(fp[1]!);
  const [type = "", data = ""] = s.split(/[\t ]+/);
  const blob = decodeBase64(data);
  if (blob === undefined || blob.length < 4) return fail("blob");
  // Блоб начинается строкой SSH (uint32 длина + байты) с тем же типом ключа.
  const len = new DataView(blob.buffer, blob.byteOffset).getUint32(0);
  if (len + 4 > blob.length || new TextDecoder().decode(blob.subarray(4, 4 + len)) !== type) return fail("blob");
  return ok(encodeBase64(sha256(blob)));
}
