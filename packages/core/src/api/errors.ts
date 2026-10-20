// Ошибка API с кодом из contracts/http-api.md и сообщением из файла локализации.
import { ERROR_STATUS, message, type ErrorCode, type MessageCode } from "@aristotel/protocol";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: Record<string, unknown>;

  /** messageCode — другой текст для того же кода ошибки (например, not_found для Члена Группы). */
  constructor(
    code: ErrorCode,
    params: Record<string, string | number> = {},
    extra: Record<string, unknown> = {},
    messageCode: MessageCode = code as MessageCode,
  ) {
    super(message(messageCode, params));
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.extra = extra;
  }

  body(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

/** Ошибки SQLite, при которых изменение не сохранено из-за файла БД или места на диске. */
export function isStorageUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${(error as { code?: string }).code ?? ""} ${error.message}` : "";
  return /SQLITE_(FULL|READONLY|CANTOPEN|IOERR)|database or disk is full|readonly database|disk I\/O error|unable to open database/i.test(
    text,
  );
}
