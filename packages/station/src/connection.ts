// Соединение Станции с Опорной станцией — только через Проход (STATION-01, STATION-07): Проходы по
// очереди с тайм-аутом на попытку, удачный — первым (STATION-05); вызов Прохода подписывается Ключом
// станции или ключом Прохода Приглашения (STATION-04); Ретранслятор Станция не удостоверяет
// (STATION-41), внутри склейки — TLS 1.3 до Опорной станции со сверкой закреплённого отпечатка
// (STATION-03); пул до 4 соединений с повторным использованием (research R6, R8, R13 фичи 004).
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import {
  API_VERSION_HEADER,
  API_VERSIONS,
  PASSAGE_CHALLENGE_HEADER,
  PASSAGE_KEY_HEADER,
  PASSAGE_SIGNATURE_HEADER,
  UPGRADE_PASSAGE,
  decodeBytes,
  encodeBytes,
  passageMessage,
  type VersionInfo,
} from "@aristotel/protocol";
import { pinnedTlsConnect, TlsMismatchError } from "@aristotel/core";

export interface PassageSigner {
  publicKey: string;
  sign: (message: Uint8Array) => Uint8Array;
}

export interface ConnectorOptions {
  code: string;
  passages: string[];
  baseTlsSpki: string;
  signer: PassageSigner;
  /** Тайм-аут одной попытки через один Проход (по умолчанию 5 с, SC-005). */
  attemptMs?: number;
}

export class NoPassageError extends Error {
  /** Каждый Проход ответил отказом ключу (403): ключа нет в перечне, а не «нет связи» (STATION-22). */
  readonly refused: boolean;
  constructor(refused = false) {
    super("no_passage");
    this.refused = refused;
  }
}

/** Ретранслятор ответил на соединение статусом — отказ Прохода, а не сбой сети. */
class PassageRefusal extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`passage_${status}`);
    this.status = status;
  }
}

export class UpdateRequiredError extends Error {
  readonly supported: number[];
  constructor(supported: number[]) {
    super("update_required");
    this.supported = supported;
  }
}

export interface BaseResponse {
  status: number;
  text: string;
  json: () => Record<string, unknown>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("timeout"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Запрос к Ретранслятору по HTTPS без сверки отпечатка (STATION-41). */
function relayCall(
  url: URL,
  path: string,
  init: { method: string; headers?: Record<string, string>; upgrade?: boolean; signal: AbortSignal },
): Promise<{ status: number; body: string } | { socket: Duplex }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      signal: init.signal,
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port === "" ? 443 : Number(url.port),
      path,
      method: init.method,
      headers: init.headers ?? {},
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      agent: false,
    });
    req.on("upgrade", (_res, socket, head) => {
      if (head.length > 0) socket.unshift(head);
      resolve({ socket });
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

export class BaseConnector {
  #passages: string[];
  readonly #code: string;
  readonly #baseTlsSpki: string;
  #signer: PassageSigner;
  readonly #attemptMs: number;
  #agent: http.Agent;
  /** Последняя ошибка TLS-отпечатка — интерфейс показывает оба отпечатка (STATION-35, фича 015). */
  lastMismatch: TlsMismatchError | undefined;
  /** С какого времени нет связи (STATION-25 — показ, фича 009). */
  offlineSince: string | null = null;
  /** Через какой Проход связь сейчас. */
  current: string | null = null;

  constructor(options: ConnectorOptions) {
    this.#code = options.code;
    this.#passages = [...options.passages];
    this.#baseTlsSpki = options.baseTlsSpki;
    this.#signer = options.signer;
    this.#attemptMs = options.attemptMs ?? 5000;
    this.#agent = this.#makeAgent();
  }

  #makeAgent(): http.Agent {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 10_000 });
    // Сокет — склейка через Проход и TLS до Опорной станции; открывается асинхронно (research R13).
    (agent as unknown as { createConnection: unknown }).createConnection = (_options: unknown, callback: (error: Error | null, socket?: Duplex) => void) => {
      this.openTunnel().then(
        (socket) => callback(null, socket),
        (error: Error) => callback(error),
      );
      return undefined;
    };
    return agent;
  }

  get passages(): string[] {
    return [...this.#passages];
  }

  /** Новый перечень Проходов (STATION-42): удачный остаётся первым, если он в перечне. */
  setPassages(passages: string[]): void {
    const current = this.current;
    this.#passages = current !== null && passages.includes(current) ? [current, ...passages.filter((p) => p !== current)] : [...passages];
  }

  /** Подписывать вызов Прохода другим ключом: после приёма — Ключом станции. */
  setSigner(signer: PassageSigner): void {
    this.#signer = signer;
  }

  async #through(passage: string): Promise<TLSSocket> {
    const url = new URL(passage);
    let raw: Duplex | undefined;
    // Тайм-аут отменяет всю попытку — и вызов, и Upgrade, и TLS внутри склейки: зависшие запросы не копятся.
    const abort = new AbortController();
    const attempt = async (): Promise<TLSSocket> => {
      const challengeRes = await relayCall(url, `/relay/v1/prohod/${this.#code}/vyzov`, { method: "POST", signal: abort.signal });
      if (!("status" in challengeRes) || challengeRes.status !== 200) throw new Error("passage_challenge");
      const challenge = String((JSON.parse(challengeRes.body) as { challenge?: unknown }).challenge ?? "");
      const bytes = decodeBytes(challenge, 32);
      if (bytes === undefined) throw new Error("passage_challenge");
      const upgraded = await relayCall(url, `/relay/v1/prohod/${this.#code}/soedinenie`, {
        method: "GET",
        upgrade: true,
        signal: abort.signal,
        headers: {
          connection: "Upgrade",
          upgrade: UPGRADE_PASSAGE,
          [PASSAGE_KEY_HEADER]: this.#signer.publicKey,
          [PASSAGE_CHALLENGE_HEADER]: challenge,
          [PASSAGE_SIGNATURE_HEADER]: encodeBytes(this.#signer.sign(passageMessage(this.#code, bytes))),
        },
      });
      if (!("socket" in upgraded)) throw new PassageRefusal(upgraded.status);
      raw = upgraded.socket;
      // Внутри склейки — TLS до Опорной станции со сверкой закреплённого отпечатка (STATION-03).
      return await pinnedTlsConnect({ socket: upgraded.socket }, this.#baseTlsSpki);
    };
    return await withTimeout(attempt(), this.#attemptMs, () => {
      abort.abort();
      raw?.destroy();
    });
  }

  /** Склеенное соединение с TLS до Опорной станции: Проходы по очереди, удачный — первым. */
  async openTunnel(): Promise<TLSSocket> {
    let refusals = 0;
    for (const passage of this.#passages) {
      try {
        const socket = await this.#through(passage);
        this.current = passage;
        this.offlineSince = null;
        this.lastMismatch = undefined;
        if (this.#passages[0] !== passage) this.#passages = [passage, ...this.#passages.filter((p) => p !== passage)];
        return socket;
      } catch (error) {
        // Другой отпечаток Опорной станции — не сбой Прохода: Станция не соединяется (STATION-03).
        if (error instanceof TlsMismatchError) {
          this.lastMismatch = error;
          throw error;
        }
        if (error instanceof PassageRefusal && error.status === 403) refusals++;
      }
    }
    this.current = null;
    this.offlineSince ??= new Date().toISOString();
    throw new NoPassageError(this.#passages.length > 0 && refusals === this.#passages.length);
  }

  /** HTTP-запрос к API Станций через пул склеенных соединений. */
  request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<BaseResponse> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: "aristotel", [API_VERSION_HEADER]: String(API_VERSIONS.at(-1)), ...options.headers };
      const text = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (text !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(text));
      }
      const req = http.request({ agent: this.#agent, method, path, headers, host: "aristotel" }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: data,
            json: () => (data === "" ? {} : (JSON.parse(data) as Record<string, unknown>)),
          }),
        );
      });
      req.on("error", reject);
      req.end(text);
    });
  }

  /**
   * Запрос с телом application/octet-stream — часть файла Материала (research R6 фичи 006): тот же агент
   * склеенных соединений, что у JSON-запросов.
   */
  requestBinary(method: string, path: string, body: Uint8Array, headers: Record<string, string> = {}): Promise<BaseResponse> {
    return new Promise((resolve, reject) => {
      const all: Record<string, string> = {
        host: "aristotel",
        [API_VERSION_HEADER]: String(API_VERSIONS.at(-1)),
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
      };
      const req = http.request({ agent: this.#agent, method, path, headers: all, host: "aristotel" }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data, json: () => (data === "" ? {} : (JSON.parse(data) as Record<string, unknown>)) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  /** Совместимость версии API (APP-23): Станция с несовместимой версией не входит и предлагает обновиться. */
  async checkApiVersion(): Promise<void> {
    const res = await this.request("GET", "/api/version");
    const info = res.json() as unknown as VersionInfo;
    if (res.status !== 200 || !API_VERSIONS.some((v) => info.apiVersions.includes(v))) throw new UpdateRequiredError(info.apiVersions ?? []);
  }

  /** Закрыть все соединения пула (выход, отзыв, смена ключа подписи вызова). */
  close(): void {
    this.#agent.destroy();
    this.#agent = this.#makeAgent();
  }
}
