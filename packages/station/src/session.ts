// Сеанс Станции «только удаление» на её стороне (STATION-20, STATION-22; contracts/stanciya-v1.md
// «Команда удаления»; research R11 фичи 004): получить команду, подписать подтверждение Ключом станции,
// отправить. Файлы удаляет и останавливается вызывающий — локальная часть.
import { deletionMessage, encodeBytes, type SessionResponse } from "@aristotel/protocol";
import { NoPassageError, type BaseResponse } from "./connection.ts";
import type { StationKey } from "./station-key.ts";

/** Вход отклонён Опорной станцией (не 201 на POST /api/session). */
export class SessionRefusedError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export interface DeletionContext {
  key: StationKey;
  /** Текущий сеанс локальной части — может смениться между попытками (новый вход). */
  session: () => SessionResponse | undefined;
  stopped: () => boolean;
  request: (method: string, path: string, options?: { body?: unknown }) => Promise<BaseResponse>;
  retryMs: number;
}

/**
 * Выполнить команду удаления; true — удаление подтверждено и файлы можно удалять. Соединения пула,
 * порванные отзывом, отваливаются не сразу — несколько попыток.
 */
export async function confirmDeletion(ctx: DeletionContext): Promise<boolean> {
  let confirmSent = false;
  for (let attempt = 0; attempt < 5 && !ctx.stopped(); attempt++) {
    const session = ctx.session();
    if (session === undefined || session.scope !== "delete-only") return false;
    try {
      const command = await ctx.request("GET", "/api/station/deletion");
      if (command.status !== 200) return false;
      const commandId = String(command.json()["commandId"] ?? "");
      const signature = encodeBytes(ctx.key.sign(deletionMessage(session.stationId, commandId)));
      confirmSent = true;
      const confirmed = await ctx.request("POST", "/api/station/deletion/confirm", { body: { commandId, signature } });
      return confirmed.status === 200;
    } catch (error) {
      // Ответ на подтверждение потерян, а вход больше не принимают или Ретранслятор уже не знает ключа
      // (перечень без него рассылается после подтверждения), — удаление подтверждено. «Нет связи» —
      // не признак: тогда команда повторится при следующем входе.
      if (confirmSent && (error instanceof SessionRefusedError || (error instanceof NoPassageError && error.refused))) return true;
      await new Promise((resolve) => setTimeout(resolve, ctx.retryMs));
    }
  }
  return false;
}
