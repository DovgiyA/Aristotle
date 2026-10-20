// Клиент Ретрансляторов на Опорной станции: на каждый Ретранслятор своей записи в последней
// применённой версии Реестра — TLS со сверкой отпечатка, вход подписанным вызовом Ключом Группы,
// обмен версиями Реестра, исходящее управляющее соединение, приём вызовов и открытие соединения для
// склейки. Входящих портов у Опорной станции нет (RELAY-03, RELAY-08, RELAY-10, RELAY-16 … RELAY-18,
// RELAY-21, STATION-02, STATION-05; contracts/prohod-v1.md; research R4, R5 фичи 004).
import http from "node:http";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import {
  CONTROL_PING_MS,
  CONTROL_SILENCE_MS,
  REGISTRY_FORMAT,
  UPGRADE_CONTROL,
  UPGRADE_PASSAGE,
  decodeBytes,
  encodeBytes,
  parseControlMessage,
  parseSignedDocument,
  relayLoginMessage,
  type Relay,
  type RelayLoginResponse,
} from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import { inTransaction } from "../db/open.ts";
import type { GroupKeyHandle } from "../network/group-key.ts";
import { applyVersion, registryDocumentText, registryState } from "../network/registry.ts";
import { networkEvents } from "../network/events.ts";
import { pinnedTlsConnect, TlsMismatchError } from "../tls/tls-key.ts";
import { passageList } from "./passage-list.ts";

export interface RelayClientTimers {
  ping: number;
  silence: number;
  /** Пауза перед повторным входом: удваивается от min до max. */
  retryMin: number;
  retryMax: number;
  /** Повторный вход до истечения токена (15 минут). */
  relogin: number;
  /** Не чаще одной записи журнала relay.* на Ретранслятор и причину. */
  journalEvery: number;
}

export const DEFAULT_RELAY_TIMERS: RelayClientTimers = {
  ping: CONTROL_PING_MS,
  silence: CONTROL_SILENCE_MS,
  retryMin: 1000,
  retryMax: 30_000,
  relogin: 10 * 60 * 1000,
  journalEvery: 60 * 60 * 1000,
};

export interface RelayClientOptions {
  db: Db;
  groupKey: GroupKeyHandle;
  /** Сокет склейки от Ретранслятора — внутренний TLS к API Станций (US2, inner-tls.ts). */
  onSplice?: (socket: Duplex) => void;
  timers?: Partial<RelayClientTimers>;
}

export interface RelayLinkState {
  url: string;
  connected: boolean;
  since: string | null;
}

interface Response {
  status: number;
  body: Record<string, unknown>;
}

class RelayRequestError extends Error {}

/** Один Ретранслятор: вход, управляющее соединение, повторы. */
class RelayLink {
  readonly relay: Relay;
  readonly #client: RelayClient;
  readonly #host: string;
  readonly #port: number;
  #token = "";
  #control: Duplex | undefined;
  #stopped = false;
  #retry: number;
  #timer: NodeJS.Timeout | undefined;
  #relogin: NodeJS.Timeout | undefined;
  #connectedSince: string | null = null;
  #lastHeard = 0;

  constructor(client: RelayClient, relay: Relay) {
    this.#client = client;
    this.relay = relay;
    const url = new URL(relay.url);
    this.#host = url.hostname.replace(/^\[|\]$/g, "");
    this.#port = url.port === "" ? 443 : Number(url.port);
    this.#retry = client.timers.retryMin;
  }

  state(): RelayLinkState {
    return { url: this.relay.url, connected: this.#control !== undefined, since: this.#connectedSince };
  }

  start(): void {
    void this.#run();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#relogin !== undefined) clearTimeout(this.#relogin);
    this.#control?.destroy();
    this.#control = undefined;
  }

  sendList(): void {
    this.#control?.write(`${JSON.stringify({ type: "passage-list", keys: passageList(this.#client.db) })}\n`);
  }

  async #run(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#login();
      await this.#openControl();
      this.#retry = this.#client.timers.retryMin;
    } catch (error) {
      this.#client.noteFailure(this.relay, error);
      this.#schedule();
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    const wait = this.#retry;
    this.#retry = Math.min(this.#retry * 2, this.#client.timers.retryMax);
    this.#timer = setTimeout(() => void this.#run(), wait);
    this.#timer.unref();
  }

  async #socket(): Promise<TLSSocket> {
    return await pinnedTlsConnect({ host: this.#host, port: this.#port }, this.relay.tlsSpki);
  }

  async #request(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
    const socket = await this.#socket();
    return await new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: this.#host };
      if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
      const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      if (text !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(text));
      }
      const req = http.request({ method, path, headers, createConnection: () => socket }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => {
          socket.destroy();
          try {
            resolve({ status: res.statusCode ?? 0, body: data === "" ? {} : (JSON.parse(data) as Record<string, unknown>) });
          } catch {
            reject(new RelayRequestError("bad_response"));
          }
        });
      });
      req.on("error", reject);
      req.end(text);
    });
  }

  async #login(): Promise<void> {
    const { db, groupKey } = this.#client;
    const own = this.#client.ownGroup();
    if (own === undefined) throw new RelayRequestError("no_registry");
    if (groupKey.info().state === "unavailable") throw new RelayRequestError("group_key_unavailable");
    const challengeRes = await this.#request("POST", "/relay/v1/vhod/vyzov");
    const challenge = String(challengeRes.body["challenge"] ?? "");
    const challengeBytes = decodeBytes(challenge, 32);
    const spki = decodeBytes(this.relay.tlsSpki, 32);
    if (challengeRes.status !== 200 || challengeBytes === undefined || spki === undefined) throw new RelayRequestError("challenge");
    const signature = encodeBytes(groupKey.sign(relayLoginMessage(own.code, challengeBytes, spki)));
    const send = () => this.#request("POST", "/relay/v1/vhod", { code: own.code, registryNumber: registryNumber(db), challenge, signature });
    let res = await send();
    if (res.status === 409 && res.body["error"] === "registry_needed") {
      // RELAY-17: станция сама приносит версии, по которым её впустят; вызов при этом не тратится.
      const relayNumber = Number(res.body["registryNumber"] ?? 0);
      for (let n = relayNumber + 1; n <= registryNumber(db); n++) {
        const text = registryDocumentText(db, n);
        if (text !== undefined) await this.#request("PUT", "/relay/v1/reestr", text);
      }
      res = await send();
    }
    if (res.status !== 200) throw new RelayRequestError(res.status === 403 ? "forbidden" : `status_${res.status}`);
    const body = res.body as unknown as RelayLoginResponse;
    this.#token = body.token;
    for (const text of body.versions ?? []) this.#client.applyFromRelay(text);
    if (body.conflict !== undefined) this.#client.journalRelay(this.relay, "relay.registry-conflict", { number: body.conflict.number });
    if (this.#relogin !== undefined) clearTimeout(this.#relogin);
    this.#relogin = setTimeout(() => {
      this.#login().catch((error) => this.#client.noteFailure(this.relay, error));
    }, this.#client.timers.relogin);
    this.#relogin.unref();
  }

  async #upgrade(path: string, protocol: string): Promise<Duplex> {
    const socket = await this.#socket();
    return await new Promise((resolve, reject) => {
      const req = http.request({
        method: "GET",
        path,
        headers: { host: this.#host, authorization: `Bearer ${this.#token}`, connection: "Upgrade", upgrade: protocol },
        createConnection: () => socket,
      });
      req.on("upgrade", (_res, upgraded, head) => {
        if (head.length > 0) upgraded.unshift(head);
        resolve(upgraded);
      });
      req.on("response", (res) => {
        res.resume();
        socket.destroy();
        reject(new RelayRequestError(`status_${res.statusCode}`));
      });
      req.on("error", reject);
      req.end();
    });
  }

  async #openControl(): Promise<void> {
    const own = this.#client.ownGroup()!;
    const control = await this.#upgrade(`/relay/v1/prohod/${own.code}/upravlenie`, UPGRADE_CONTROL);
    this.#control = control;
    this.#connectedSince = new Date().toISOString();
    this.#lastHeard = Date.now();
    this.sendList();
    let buffer = "";
    control.on("data", (chunk: Buffer) => {
      this.#lastHeard = Date.now();
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const message = parseControlMessage(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message?.type === "call") void this.#accept(own.code, message.callId);
        else if (message?.type === "ping") control.write(`${JSON.stringify({ type: "pong" })}\n`);
        newline = buffer.indexOf("\n");
      }
    });
    const ping = setInterval(() => {
      if (Date.now() - this.#lastHeard > this.#client.timers.silence) {
        control.destroy();
        return;
      }
      control.write(`${JSON.stringify({ type: "ping" })}\n`);
    }, this.#client.timers.ping);
    control.on("error", () => control.destroy());
    control.once("close", () => {
      clearInterval(ping);
      if (this.#control === control) {
        this.#control = undefined;
        this.#connectedSince = null;
      }
      this.#schedule();
    });
  }

  async #accept(code: string, callId: string): Promise<void> {
    try {
      const socket = await this.#upgrade(`/relay/v1/prohod/${code}/priem/${callId}`, UPGRADE_PASSAGE);
      this.#client.splice(socket);
    } catch {
      // Вызов пропал или Ретранслятор отказал — Станция попробует снова.
    }
  }
}

function registryNumber(db: Db): number {
  return registryState(db).current?.number ?? 0;
}

export class RelayClient {
  readonly db: Db;
  readonly groupKey: GroupKeyHandle;
  readonly timers: RelayClientTimers;
  readonly #links = new Map<string, RelayLink>();
  readonly #journaled = new Map<string, number>();
  #onSplice: (socket: Duplex) => void;
  readonly #onApplied = () => this.refresh();
  readonly #onList = () => {
    for (const link of this.#links.values()) link.sendList();
  };

  constructor(options: RelayClientOptions) {
    this.db = options.db;
    this.groupKey = options.groupKey;
    this.timers = { ...DEFAULT_RELAY_TIMERS, ...options.timers };
    this.#onSplice = options.onSplice ?? ((socket) => socket.destroy());
  }

  setSpliceHandler(handler: (socket: Duplex) => void): void {
    this.#onSplice = handler;
  }

  splice(socket: Duplex): void {
    this.#onSplice(socket);
  }

  /** Своя запись в последней применённой версии — по Ключу Группы (NET-07, NET-11). */
  ownGroup(): { code: string; relays: Relay[] } | undefined {
    const current = registryState(this.db).current;
    const signingKey = this.groupKey.info().signingKey;
    const own = current?.body.groups.find((g) => g.signingKey === signingKey && g.state === "active");
    return own === undefined ? undefined : { code: own.code, relays: own.relays };
  }

  start(): void {
    networkEvents.on("registry-applied", this.#onApplied);
    networkEvents.on("passage-list-changed", this.#onList);
    this.refresh();
  }

  stop(): void {
    networkEvents.off("registry-applied", this.#onApplied);
    networkEvents.off("passage-list-changed", this.#onList);
    for (const link of this.#links.values()) link.stop();
    this.#links.clear();
  }

  /** Ретрансляторы следуют последней применённой версии: ушёл — закрыть, появился — войти (STATION-05). */
  refresh(): void {
    const wanted = new Map((this.ownGroup()?.relays ?? []).map((r) => [`${r.url} ${r.tlsSpki}`, r]));
    for (const [key, link] of this.#links) {
      if (!wanted.has(key)) {
        link.stop();
        this.#links.delete(key);
      }
    }
    for (const [key, relay] of wanted) {
      if (this.#links.has(key)) continue;
      const link = new RelayLink(this, relay);
      this.#links.set(key, link);
      link.start();
    }
  }

  states(): RelayLinkState[] {
    return [...this.#links.values()].map((l) => l.state());
  }

  /** Версия от Ретранслятора: станция проверяет её сама по NET-09; автор — служба (RELAY-18). */
  applyFromRelay(text: string): void {
    try {
      parseSignedDocument(text, REGISTRY_FORMAT);
      applyVersion(this.db, this.groupKey, { service: true }, text);
    } catch {
      // Отказ по правилам Реестра уже записан в журнал (registry.reject, registry.conflict).
    }
  }

  journalRelay(relay: Relay, action: "relay.registry-conflict" | "relay.tls-mismatch" | "relay.login-failed", details: Record<string, unknown>): void {
    const key = `${relay.url} ${action} ${String(details["reason"] ?? details["number"] ?? "")}`;
    const now = Date.now();
    const last = this.#journaled.get(key);
    if (last !== undefined && now - last < this.timers.journalEvery) return;
    this.#journaled.set(key, now);
    inTransaction(this.db, () => {
      this.db
        .prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, NULL, ?, 'relay', ?, ?)")
        .run(new Date().toISOString(), action, relay.url, JSON.stringify({ relay: relay.url, ...details }));
    });
  }

  noteFailure(relay: Relay, error: unknown): void {
    if (error instanceof TlsMismatchError) this.journalRelay(relay, "relay.tls-mismatch", {});
    else if (error instanceof RelayRequestError && (error.message === "forbidden" || error.message === "group_key_unavailable")) {
      this.journalRelay(relay, "relay.login-failed", { reason: error.message });
    }
  }
}
