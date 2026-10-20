// Локальная часть Станции: Ключ станции открыт от ввода пароля до выхода (STATION-09, STATION-11);
// вход подписанным вызовом с привязкой к TLS-каналу и короткий токен с продлением без пароля
// (STATION-10); перечень Проходов при входе и из событий (STATION-42); совместимость версии API
// (APP-23); всё, что Станция делает с Банком, — через сеанс и Проход (STATION-01, STATION-07; research
// R8, R13 фичи 004).
import http from "node:http";
import type { TLSSocket } from "node:tls";
import {
  API_VERSIONS,
  API_VERSION_HEADER,
  SESSION_RENEW_BEFORE_MS,
  STATION_EKM_LABEL,
  decodeBytes,
  encodeBytes,
  keyFingerprint,
  stationLoginMessage,
  type LocalPartState,
  type Role,
  type SessionResponse,
} from "@aristotel/protocol";
import { TlsMismatchError } from "@aristotel/core";
import { BaseConnector, UpdateRequiredError, type BaseResponse } from "./connection.ts";
import { openStationKey, type StationKey } from "./station-key.ts";
import { deleteStationFiles, isAccepted, readStationState, writeStationState, type StationState } from "./station-files.ts";
import { SessionRefusedError, confirmDeletion } from "./session.ts";

export { SessionRefusedError } from "./session.ts";

export interface LocalPartOptions {
  dataDir: string;
  /** Тайм-аут попытки через один Проход (по умолчанию 5 с). */
  attemptMs?: number;
  /** Пауза между повторами входа и событий, мс. */
  retryMs?: number;
  /** Команда удаления выполнена: файлы удалены, локальная часть остановлена (STATION-22). */
  onDeleted?: () => void;
}

/** Тип ответа — общий с CLI и интерфейсом (protocol). */
export type { LocalPartState } from "@aristotel/protocol";

export class StationLockedError extends Error {
  constructor() {
    super("station_locked");
  }
}

/** Ключ станции удалён по команде Опорной станции — ничего больше не делать (STATION-22). */
export class StationDeletedError extends Error {
  constructor() {
    super("station_deleted");
  }
}

/** Ответ Опорной станции на запрос через сеанс. */
export type LocalResponse = BaseResponse;

export class LocalPart {
  readonly dataDir: string;
  readonly #attemptMs: number | undefined;
  readonly #retryMs: number;
  #key: StationKey | undefined;
  #connector: BaseConnector | undefined;
  #session: SessionResponse | undefined;
  #renewTimer: NodeJS.Timeout | undefined;
  #stopped = false;
  #eventsSeq = 0;
  #updateRequired = false;
  #loginInFlight: Promise<void> | undefined;
  #deleted = false;
  #deletion: Promise<void> | undefined;
  readonly #onDeleted: (() => void) | undefined;
  /** Ключ станции открыт — продолжить недоставленное (очередь Материалов, фича 006). */
  onUnlocked: (() => void) | undefined;
  /** Вход выполнен — подобрать потерянные копии и продолжить доставку (T094). */
  onSession: (() => void) | undefined;

  constructor(options: LocalPartOptions) {
    this.dataDir = options.dataDir;
    this.#onDeleted = options.onDeleted;
    this.#attemptMs = options.attemptMs;
    this.#retryMs = options.retryMs ?? 1000;
  }

  /** Команда удаления выполнена: Ключа станции и station.json больше нет. */
  get deleted(): boolean {
    return this.#deleted;
  }

  get unlocked(): boolean {
    return this.#key !== undefined;
  }

  get session(): SessionResponse | undefined {
    return this.#session;
  }

  get stationKey(): StationKey | undefined {
    return this.#key;
  }

  state(): LocalPartState {
    const accepted = isAccepted(this.dataDir);
    const station: StationState | undefined = accepted ? readStationState(this.dataDir) : undefined;
    const mismatch = this.#connector?.lastMismatch;
    return {
      accepted,
      unlocked: this.unlocked,
      connected: this.#session !== undefined && this.#connector?.current !== null && this.#connector?.current !== undefined,
      offlineSince: this.#connector?.offlineSince ?? null,
      passage: this.#connector?.current ?? null,
      memberId: station?.memberId ?? null,
      memberLabel: station?.memberLabel ?? null,
      role: this.#session?.role ?? (station?.role as Role | undefined) ?? null,
      stationKeyFingerprint: this.#key === undefined ? null : keyFingerprint(this.#key.publicKey),
      baseTlsSpki: station?.baseTlsSpki ?? null,
      tlsMismatch: mismatch === undefined ? null : { expected: mismatch.expected, seen: mismatch.seen },
      updateRequired: this.#updateRequired,
    };
  }

  /** Пароль открывает Ключ станции; неверный — KeyFileError, ключ не открыт (STATION-09). */
  async unlock(password: string): Promise<void> {
    const key = await openStationKey(this.dataDir, password);
    if (this.#key === undefined) {
      this.#key = key;
      const station = readStationState(this.dataDir);
      const options = { code: station.code, passages: station.passages, baseTlsSpki: station.baseTlsSpki, signer: key };
      this.#connector = new BaseConnector(this.#attemptMs === undefined ? options : { ...options, attemptMs: this.#attemptMs });
      void this.#connectLoop();
      this.onUnlocked?.();
    }
  }

  /** Проверить пароль заново, не меняя состояния (подтверждение присутствия, разблокировка интерфейса). */
  async checkPassword(password: string): Promise<StationKey> {
    return await openStationKey(this.dataDir, password);
  }

  async #connectLoop(): Promise<void> {
    while (!this.#stopped && this.#session === undefined) {
      try {
        await this.login();
        void this.#eventsLoop();
        return;
      } catch (error) {
        if (error instanceof UpdateRequiredError) {
          this.#updateRequired = true;
          return;
        }
        if (error instanceof TlsMismatchError) return;
        await new Promise((resolve) => setTimeout(resolve, this.#retryMs));
      }
    }
  }

  /** Вход: вызов через пул, подпись над вызовом и EKM выделенного TLS-соединения (STATION-10). */
  async login(): Promise<void> {
    if (this.#loginInFlight !== undefined) return await this.#loginInFlight;
    this.#loginInFlight = this.#login().finally(() => {
      this.#loginInFlight = undefined;
    });
    return await this.#loginInFlight;
  }

  async #login(): Promise<void> {
    const connector = this.#connector;
    const key = this.#key;
    if (connector === undefined || key === undefined) throw new StationLockedError();
    await connector.checkApiVersion();
    const challengeRes = await connector.request("POST", "/api/session/challenge");
    const challenge = String(challengeRes.json()["challenge"] ?? "");
    const challengeBytes = decodeBytes(challenge, 32);
    if (challengeRes.status !== 200 || challengeBytes === undefined) throw new Error("session_challenge");
    const socket = await connector.openTunnel();
    try {
      const ekm = new Uint8Array(socket.exportKeyingMaterial(32, STATION_EKM_LABEL, Buffer.alloc(0)));
      const body = { stationKey: key.publicKey, challenge, signature: encodeBytes(key.sign(stationLoginMessage(challengeBytes, ekm))) };
      const headers: Record<string, string> = {};
      if (this.#session !== undefined) headers["authorization"] = `Bearer ${this.#session.token}`;
      const res = await requestOn(socket, "POST", "/api/session", body, headers);
      if (res.status !== 201) {
        this.#session = undefined;
        throw new SessionRefusedError(String(res.json()["error"] ?? "session_refused"), res.status);
      }
      this.#session = res.json() as unknown as SessionResponse;
    } finally {
      socket.destroy();
    }
    this.#applyPassages(this.#session.passages);
    this.#scheduleRenewal();
    if (this.#session.scope === "full") this.onSession?.();
    // Станция отозвана, срок не вышел — выполнить команду удаления (STATION-20, STATION-22).
    if (this.#session.scope === "delete-only") this.#deletion ??= this.#runDeletion().finally(() => (this.#deletion = undefined));
  }

  /**
   * Команда удаления: подписать подтверждение Ключом станции; после 200 удалить station-key.age и
   * station.json и остановиться (contracts/stanciya-v1.md «Команда удаления»).
   */
  async #runDeletion(): Promise<void> {
    const key = this.#key;
    if (key === undefined) return;
    const done = await confirmDeletion({
      key,
      session: () => this.#session,
      stopped: () => this.#stopped,
      request: (method, path, options) => this.request(method, path, options),
      retryMs: this.#retryMs,
    });
    if (!done) return; // нет связи — команда повторится при следующем входе
    deleteStationFiles(this.dataDir);
    this.#deleted = true;
    this.#stopped = true;
    if (this.#renewTimer !== undefined) clearTimeout(this.#renewTimer);
    this.#session = undefined;
    this.#key = undefined;
    this.#connector?.close();
    this.#onDeleted?.();
  }

  #scheduleRenewal(): void {
    if (this.#renewTimer !== undefined) clearTimeout(this.#renewTimer);
    const session = this.#session;
    if (session === undefined || this.#stopped) return;
    const wait = Math.max(1000, Date.parse(session.expiresAt) - Date.now() - SESSION_RENEW_BEFORE_MS);
    this.#renewTimer = setTimeout(() => {
      this.login().catch(() => {
        this.#session = undefined;
        void this.#connectLoop();
      });
    }, wait);
    this.#renewTimer.unref();
  }

  #applyPassages(passages: string[]): void {
    if (passages.length === 0 || this.#connector === undefined) return;
    this.#connector.setPassages(passages);
    const station = readStationState(this.dataDir);
    if (JSON.stringify(station.passages) !== JSON.stringify(passages)) writeStationState(this.dataDir, { ...station, passages });
  }

  /** Долгий запрос событий: смена записи Группы — новый перечень Проходов (STATION-42). */
  async #eventsLoop(): Promise<void> {
    while (!this.#stopped && this.#session !== undefined && this.#session.scope === "full") {
      try {
        const res = await this.request("GET", `/api/station/events?after=${this.#eventsSeq}`);
        if (res.status === 200) {
          const body = res.json() as { seq: number; passages: string[] };
          this.#eventsSeq = body.seq;
          this.#applyPassages(body.passages);
        } else if (res.status !== 204) {
          await new Promise((resolve) => setTimeout(resolve, this.#retryMs));
        }
      } catch {
        // Соединение порвано: Станцию могли отозвать или сдать — сразу войти снова (research R11).
        if (this.#stopped) return;
        try {
          // Тот же токен: сеанс жив — продление без записи журнала; закрыт отзывом — новый вход.
          await this.login();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, this.#retryMs));
        }
      }
    }
    // Вне сеанса (вход не удался) — подключаться снова, пока не остановлены.
    if (!this.#stopped && this.#session === undefined) void this.#connectLoop();
  }

  /** Запрос к Банку через сеанс; сеанс истёк или потерян — один повторный вход (STATION-11). */
  async request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<LocalResponse> {
    if (this.#deleted) throw new StationDeletedError();
    if (this.#key === undefined || this.#connector === undefined) throw new StationLockedError();
    if (this.#session === undefined) await this.login();
    const send = () =>
      this.#connector!.request(method, path, {
        ...(options.body === undefined ? {} : { body: options.body }),
        headers: { ...options.headers, authorization: `Bearer ${this.#session!.token}` },
      });
    let res = await send();
    if (res.status === 401) {
      this.#session = undefined;
      await this.login();
      res = await send();
    }
    return res;
  }

  /** Часть файла Материала через сеанс (research R6 фичи 006); сеанс потерян — один повторный вход. */
  async requestBinary(method: string, path: string, body: Uint8Array, headers: Record<string, string> = {}): Promise<LocalResponse> {
    if (this.#deleted) throw new StationDeletedError();
    if (this.#key === undefined || this.#connector === undefined) throw new StationLockedError();
    if (this.#session === undefined) await this.login();
    const send = () => this.#connector!.requestBinary(method, path, body, { ...headers, authorization: `Bearer ${this.#session!.token}` });
    let res = await send();
    if (res.status === 401) {
      this.#session = undefined;
      await this.login();
      res = await send();
    }
    return res;
  }

  /** Выход: конец сеанса на Опорной станции и закрытие соединений (STATION-34). */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#renewTimer !== undefined) clearTimeout(this.#renewTimer);
    if (this.#session !== undefined && this.#connector !== undefined) {
      try {
        await this.#connector.request("DELETE", "/api/session", { headers: { authorization: `Bearer ${this.#session.token}` } });
      } catch {
        // Нет связи — сеанс закончится по сроку (expired).
      }
    }
    this.#session = undefined;
    this.#connector?.close();
  }
}


/** Один HTTP-запрос по данному TLS-соединению (вход привязан к его EKM). */
function requestOn(socket: TLSSocket, method: string, path: string, body: unknown, extra: Record<string, string>): Promise<BaseResponse> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        method,
        path,
        createConnection: () => socket,
        headers: {
          host: "aristotel",
          [API_VERSION_HEADER]: String(API_VERSIONS.at(-1)),
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
          ...extra,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data, json: () => (data === "" ? {} : (JSON.parse(data) as Record<string, unknown>)) }));
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}
