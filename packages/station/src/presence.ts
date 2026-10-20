// Подтверждение присутствия в локальной части Станции (STATION-12, research R10 фичи 004): пароль Члена
// Группы заново открывает файл Ключа станции — около секунды scrypt, — затем подпись над сеансом,
// методом, путём и телом запроса (contracts/stanciya-v1.md). Пароль не сохраняется и на Опорную станцию
// не уходит (STATION-09).
import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { encodeBytes, encodePresenceHeader, presenceBodyText, presenceMessage, sha256Hex, type PresenceResponse } from "@aristotel/protocol";
import { KeyFileError } from "@aristotel/core";
import type { LocalPart } from "./local-part.ts";
import type { StationKey } from "./station-key.ts";
import { fail } from "./http.ts";

/** Проверить пароль заново; ошибка — уже отправленный ответ (ключ закрыт — 423, неверный — 403). */
export async function recheckPassword(part: LocalPart, reply: FastifyReply, password: string): Promise<StationKey | FastifyReply> {
  if (!part.unlocked) return fail(reply, "station_locked");
  try {
    return await part.checkPassword(password);
  } catch (error) {
    if (error instanceof KeyFileError) return fail(reply, "password_wrong");
    throw error;
  }
}

/** Заголовок Aristotel-Presence для одного запроса к Банку в текущем сеансе Станции. */
export async function presenceFor(part: LocalPart, key: StationKey, method: string, path: string, body: unknown): Promise<string> {
  if (part.session === undefined) await part.login();
  const nonce = new Uint8Array(randomBytes(16));
  const issuedAt = new Date().toISOString();
  const signed = presenceMessage({
    sessionId: part.session!.sessionId,
    method,
    path: path.split("?")[0] ?? path,
    bodySha256: sha256Hex(presenceBodyText(body)),
    issuedAt,
    nonce,
  });
  return encodePresenceHeader({ issuedAt, nonce: encodeBytes(nonce), signature: encodeBytes(key.sign(signed)) });
}

/** POST /local/presence: `{ password, method, path, body }` → `{ presence }`. */
export function presenceRoutes(app: FastifyInstance, part: LocalPart): void {
  app.post<{ Body: { password?: unknown; method?: unknown; path?: unknown; body?: unknown } }>("/local/presence", async (request, reply) => {
    const { password, method, path, body } = request.body ?? {};
    if (typeof password !== "string" || typeof method !== "string" || typeof path !== "string") return fail(reply, "invalid_request", { detail: "password, method, path" });
    const key = await recheckPassword(part, reply, password);
    if (!("sign" in key)) return key;
    const response: PresenceResponse = { presence: await presenceFor(part, key, method, path, body) };
    return response;
  });
}
