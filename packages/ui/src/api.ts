// Клиент API локальной части для интерфейса (contracts/lokalnaya-chast.md): cookie сессии ставит
// сервер, CSRF-токен — заголовком на изменяющих запросах (APP-06); 423 — блокировка по простою, 403
// presence_required — диалог пароля и повтор с подтверждением присутствия (STATION-11, STATION-12).
import type { PresenceResponse, UiSessionResponse } from "@aristotel/protocol/browser";

export class LockedError extends Error {}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body["message"] === "string" ? body["message"] : String(body["error"] ?? status));
    this.status = status;
    this.code = String(body["error"] ?? "");
    this.body = body;
  }
}

/** Спросить пароль присутствия; retry — прошлый введённый пароль был неверным. */
export type PresenceAsk = (retry: boolean) => Promise<string | null>;

export class LocalApi {
  #csrf = "";
  #askPassword: PresenceAsk;
  #lastActivity = 0;

  constructor(askPassword: PresenceAsk) {
    this.#askPassword = askPassword;
  }

  /** Вход по ссылке /vhod#<токен запуска> или продолжение сессии по cookie. */
  async start(): Promise<void> {
    const launch = window.location.hash.slice(1);
    if (window.location.pathname === "/vhod" && launch !== "") {
      const res = await this.#raw<UiSessionResponse>("POST", "/local/ui-session", { launchToken: launch });
      this.#csrf = res.csrf;
      window.history.replaceState(null, "", "/");
      return;
    }
    const res = await this.#raw<UiSessionResponse>("GET", "/local/ui-session");
    this.#csrf = res.csrf;
  }

  async #raw<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const init: RequestInit = { method, credentials: "same-origin", headers: { ...headers } };
    if (method !== "GET") (init.headers as Record<string, string>)["aristotel-csrf"] = this.#csrf;
    if (path.startsWith("/api/")) (init.headers as Record<string, string>)["aristotel-api-version"] = "1";
    if (body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    if (res.status === 423 && parsed["error"] === "ui_locked") throw new LockedError();
    if (!res.ok) throw new ApiFailure(res.status, parsed);
    // Форму ответа задаёт тип из protocol у вызывающего — общий с локальной частью (конституция V).
    return parsed as T;
  }

  /** Запрос; при 403 presence_required — пароль, подпись у локальной части и повтор (STATION-12). */
  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    try {
      return (await this.#raw(method, path, body, headers)) as T;
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.code !== "presence_required") throw error;
      for (let retry = false; ; retry = true) {
        const password = await this.#askPassword(retry);
        if (password === null) throw error;
        try {
          const { presence } = await this.#raw<PresenceResponse>("POST", "/local/presence", { password, method, path, body });
          return (await this.#raw(method, path, body, { "aristotel-presence": presence })) as T;
        } catch (retry) {
          if (!(retry instanceof ApiFailure) || retry.code !== "password_wrong") throw retry;
        }
      }
    }
  }

  /** Действие человека — не чаще раза в 30 с (research R14). */
  activity(): void {
    const now = Date.now();
    if (now - this.#lastActivity < 30_000) return;
    this.#lastActivity = now;
    void this.#raw("POST", "/local/activity").catch(() => undefined);
  }
}
