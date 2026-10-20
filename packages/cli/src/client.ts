// Клиент JSON API для CLI: CLI говорит со службой только через API (BANK-06; APP-08; research R12).
import { API_VERSIONS, API_VERSION_HEADER, MEMBER_HEADER, PRESENCE_HEADER, message } from "@aristotel/protocol";

export class ClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(code: string, text: string, status = 0, body: Record<string, unknown> = {}) {
    super(text);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export interface ClientOptions {
  port: number;
  token: string;
  memberId?: string;
}

export class ApiClient {
  readonly #options: ClientOptions;
  /** Станция: подпись присутствия для повтора после 403 presence_required (STATION-12). */
  onPresenceRequired: ((method: string, path: string, body: unknown) => Promise<string>) | undefined;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  async #send(method: string, path: string, body?: unknown): Promise<string> {
    try {
      return await this.#sendOnce(method, path, body);
    } catch (error) {
      if (!(error instanceof ClientError) || error.code !== "presence_required" || this.onPresenceRequired === undefined) throw error;
      const presence = await this.onPresenceRequired(method, path, body);
      return await this.#sendOnce(method, path, body, presence);
    }
  }

  /** Отправить запрос; ошибка соединения — service_unavailable, ответ не 2xx — ClientError (APP-23). */
  async #sendOnce(method: string, path: string, body?: unknown, presence?: string): Promise<string> {
    const headers: Record<string, string> = {
      [API_VERSION_HEADER]: String(API_VERSIONS[API_VERSIONS.length - 1]),
      authorization: `Bearer ${this.#options.token}`,
    };
    if (presence !== undefined) headers[PRESENCE_HEADER] = presence;
    if (this.#options.memberId !== undefined) headers[MEMBER_HEADER] = this.#options.memberId;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await fetch(`http://127.0.0.1:${this.#options.port}${path}`, init);
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
      throw new ClientError("service_unavailable", message("service_unavailable", { detail: String(cause) }));
    }
    const text = await response.text();
    if (response.ok) return text;
    const parsed = parseObject(text);
    if (response.status === 426) {
      // Текст службы другой версии может отличаться — сообщение человеку строит сам CLI (APP-23).
      const supported = Array.isArray(parsed["supported"]) ? parsed["supported"].join(", ") : message("value_unknown");
      throw new ClientError(
        "api_version_incompatible",
        message("cli_api_version_incompatible", { local: API_VERSIONS.join(", "), supported }),
        426,
        parsed,
      );
    }
    const code = typeof parsed["error"] === "string" ? parsed["error"] : "internal_error";
    const detail = typeof parsed["message"] === "string" ? parsed["message"] : message("internal_error");
    throw new ClientError(code, detail, response.status, parsed);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await this.#send(method, path, body);
    return (text === "" ? {} : JSON.parse(text)) as T;
  }

  /** Ответ текстом как есть — документ версии Реестра (GET /api/registry/versions/{n}). */
  async requestText(path: string): Promise<string> {
    return await this.#send("GET", path);
  }
}

/** Тело ошибки как объект; не JSON — пустой объект. */
function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = text === "" ? {} : JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
