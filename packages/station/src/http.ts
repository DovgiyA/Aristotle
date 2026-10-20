// Ответ локальной части с ошибкой — тот же вид, что у Опорной станции: код и текст из локализации
// (contracts/lokalnaya-chast.md, APP-09).
import type { FastifyReply } from "fastify";
import { ERROR_STATUS, message, type ErrorCode } from "@aristotel/protocol";

export function fail(reply: FastifyReply, code: ErrorCode, params: Record<string, string> = {}): FastifyReply {
  return reply.status(ERROR_STATUS[code]).send({ error: code, message: message(code, params) });
}
