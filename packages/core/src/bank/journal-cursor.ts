// Непрозрачный курсор страниц журнала: seq, зашифрованный AES-256-GCM ключом процесса службы.
// Наблюдатель листает журнал только им — сквозные номера выдали бы Секрет-Записи пропусками
// (VIEW-59, VIEW-16; research R3). Ключ не хранится: после перезапуска службы курсор недействителен.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { message } from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEQ_BYTES = 8;

export interface JournalCursor {
  encode: (seq: number) => string;
  /** seq из курсора; испорченный или чужой курсор — 400 invalid_request. */
  decode: (cursor: string) => number;
}

export function createJournalCursor(key: Buffer = randomBytes(32)): JournalCursor {
  return {
    encode(seq) {
      const iv = randomBytes(IV_BYTES);
      const plain = Buffer.alloc(SEQ_BYTES);
      plain.writeBigUInt64BE(BigInt(seq));
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
    },
    decode(cursor) {
      const raw = Buffer.from(cursor, "base64url");
      if (raw.length !== IV_BYTES + TAG_BYTES + SEQ_BYTES) throw invalidCursor();
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
        return Number(plain.readBigUInt64BE());
      } catch {
        throw invalidCursor();
      }
    },
  };
}

function invalidCursor(): ApiError {
  return new ApiError("invalid_request", { detail: message("detail_bad_cursor") });
}
