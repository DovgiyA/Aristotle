// Подпись черновика версии Реестра Ключом Координатора в интерфейсе (NET-14, US4.9 фичи 004): два
// пароля — Члена Группы (присутствие, STATION-12) и файла ключа (формат фичи 003); файл и оба пароля —
// только в памяти этого запроса (research R10). Вместе с подписанной версией — подтверждение
// присутствия для её применения (contracts/lokalnaya-chast.md). Формат — версия Реестра или версия
// Словаря Сети (research R15 фичи 005): подтверждение — на маршрут применения своего формата.
import type { FastifyInstance } from "fastify";
import {
  REGISTRY_FORMAT,
  SLOVAR_FORMAT,
  SLOVAR_MAX_BODY_BYTES,
  addSignature,
  parseSignedDocument,
  serializeSignedDocument,
  type CoordinatorSignResponse,
  type SignedDocument,
} from "@aristotel/protocol";
import { KEY_FILE_FORMAT, KeyFileError, openKeyText } from "@aristotel/core";
import type { LocalPart } from "./local-part.ts";
import { fail } from "./http.ts";
import { presenceFor, recheckPassword } from "./presence.ts";

/** Маршрут применения версии по формату документа. */
const APPLY_PATH: Readonly<Record<string, string>> = {
  [REGISTRY_FORMAT]: "/api/registry/versions",
  [SLOVAR_FORMAT]: "/api/dictionary/versions",
};

/** Предел тела: версия Словаря Сети — до 64 МиБ плюс обвязка (contracts/slovar-v1.md). */
export const LOCAL_SIGN_BODY_LIMIT = 66 * 1024 * 1024;

/** POST /local/coordinator-sign: `{ password, keyFile, keyPassword, draft, format? }` → `{ document, presence }`. */
export function coordinatorSignRoute(app: FastifyInstance, part: LocalPart): void {
  app.post<{ Body: { password?: unknown; keyFile?: unknown; keyPassword?: unknown; draft?: unknown; format?: unknown } }>("/local/coordinator-sign", { bodyLimit: LOCAL_SIGN_BODY_LIMIT }, async (request, reply) => {
    const { password, keyFile, keyPassword, draft } = request.body ?? {};
    const format = request.body?.format ?? REGISTRY_FORMAT;
    const applyPath = typeof format === "string" ? APPLY_PATH[format] : undefined;
    if (applyPath === undefined) return fail(reply, "invalid_request", { detail: "format" });
    if (typeof password !== "string" || typeof keyFile !== "string" || typeof keyPassword !== "string" || draft === undefined) {
      return fail(reply, "invalid_request", { detail: "password, keyFile, keyPassword, draft" });
    }
    const stationKey = await recheckPassword(part, reply, password);
    if (!("sign" in stationKey)) return stationKey;
    let doc;
    try {
      doc = parseSignedDocument(typeof draft === "string" ? draft : JSON.stringify(draft), String(format), { maxBodyBytes: SLOVAR_MAX_BODY_BYTES });
    } catch {
      return fail(reply, "invalid_request", { detail: "draft" });
    }
    let key;
    try {
      key = await openKeyText(keyFile, keyPassword, KEY_FILE_FORMAT);
    } catch (error) {
      if (error instanceof KeyFileError) return reply.status(403).send({ error: `key_file_${error.code}`, message: error.message });
      throw error;
    }
    const document = JSON.parse(serializeSignedDocument(addSignature(doc, key.publicKey, key.sign))) as SignedDocument;
    const response: CoordinatorSignResponse = { document, presence: await presenceFor(part, stationKey, "POST", applyPath, document) };
    return response;
  });
}
