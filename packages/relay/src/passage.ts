// Проход на Ретрансляторе: управляющее соединение Опорной станции, перечень Прохода, вызовы и склейка
// соединения Станции с исходящим соединением Опорной станции — через HTTP Upgrade, ничего в потоках
// не разбирая (STATION-02, STATION-04, STATION-17, STATION-41; contracts/prohod-v1.md; research R5
// фичи 004). Всё — в памяти; адресов не пишет (RELAY-24).
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  CONTROL_PING_MS,
  CONTROL_SILENCE_MS,
  PASSAGE_CHALLENGE_HEADER,
  PASSAGE_KEY_HEADER,
  PASSAGE_SIGNATURE_HEADER,
  SPLICE_WAIT_MS,
  UPGRADE_CONTROL,
  UPGRADE_PASSAGE,
  decodeBytes,
  ed25519Verify,
  parseControlMessage,
  passageMessage,
  type PassageKeyEntry,
} from "@aristotel/protocol";
import type { ChallengeStore, TokenStore } from "./login.ts";
import type { Counters } from "./counters.ts";

export interface PassageTimers {
  ping: number;
  silence: number;
  spliceWait: number;
}

export const DEFAULT_PASSAGE_TIMERS: PassageTimers = { ping: CONTROL_PING_MS, silence: CONTROL_SILENCE_MS, spliceWait: SPLICE_WAIT_MS };

interface Pending {
  socket: Duplex;
  key: string;
  kind: PassageKeyEntry["kind"];
  timer: NodeJS.Timeout;
}

interface Splice {
  key: string;
  kind: PassageKeyEntry["kind"];
  station: Duplex;
  base: Duplex;
}

interface GroupPassage {
  control: Duplex | undefined;
  keys: Map<string, PassageKeyEntry>;
  pending: Map<string, Pending>;
  splices: Set<Splice>;
  pingTimer?: NodeJS.Timeout;
  lastHeard: number;
}

function refuse(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  socket.destroy();
}

function switching(socket: Duplex, protocol: string): void {
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${protocol}\r\nConnection: Upgrade\r\n\r\n`);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearer(req: IncomingMessage): string {
  const auth = header(req, "authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

export class PassageHub {
  readonly #groups = new Map<string, GroupPassage>();
  readonly #tokens: TokenStore;
  readonly #challenges: ChallengeStore;
  readonly #counters: Counters;
  readonly #timers: PassageTimers;
  #closed = false;

  constructor(tokens: TokenStore, challenges: ChallengeStore, counters: Counters, timers: PassageTimers = DEFAULT_PASSAGE_TIMERS) {
    this.#tokens = tokens;
    this.#challenges = challenges;
    this.#counters = counters;
    this.#timers = timers;
  }

  #group(code: string): GroupPassage {
    let group = this.#groups.get(code);
    if (group === undefined) {
      group = { control: undefined, keys: new Map(), pending: new Map(), splices: new Set(), lastHeard: Date.now() };
      this.#groups.set(code, group);
    }
    return group;
  }

  /** Обработчик события upgrade HTTP-сервера; возвращает false, если путь не Прохода. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const match = /^\/relay\/v1\/prohod\/([A-Z][A-Z0-9]{0,7})\/(upravlenie|soedinenie|priem\/([A-Za-z0-9_-]{1,64}))$/.exec(path);
    if (match === null) return false;
    // Ретранслятор останавливается: сокет после Upgrade сервер не закрывает сам, а close() его ждёт.
    if (this.#closed) {
      socket.destroy();
      return true;
    }
    socket.on("error", () => socket.destroy());
    if (head.length > 0) socket.unshift(head);
    const code = match[1]!;
    const kind = match[2]!;
    const upgrade = (header(req, "upgrade") ?? "").toLowerCase();
    if (kind === "upravlenie") {
      if (upgrade !== UPGRADE_CONTROL) refuse(socket, 400, "bad_request");
      else this.#control(code, req, socket);
    } else if (upgrade !== UPGRADE_PASSAGE) {
      refuse(socket, 400, "bad_request");
    } else if (kind === "soedinenie") {
      this.#stationConnect(code, req, socket);
    } else {
      this.#accept(code, match[3]!, req, socket);
    }
    return true;
  }

  #control(code: string, req: IncomingMessage, socket: Duplex): void {
    if (this.#tokens.codeOf(bearer(req)) !== code) return refuse(socket, 401, "unauthorized");
    const group = this.#group(code);
    group.control?.destroy();
    if (group.pingTimer !== undefined) clearInterval(group.pingTimer);
    group.control = socket;
    group.lastHeard = Date.now();
    switching(socket, UPGRADE_CONTROL);
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      group.lastHeard = Date.now();
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.#onControlLine(code, socket, line);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > 4 * 1024 * 1024) socket.destroy();
    });
    const timer = setInterval(() => {
      if (Date.now() - group.lastHeard > this.#timers.silence) {
        socket.destroy();
        return;
      }
      socket.write(`${JSON.stringify({ type: "ping" })}\n`);
    }, this.#timers.ping);
    group.pingTimer = timer;
    socket.once("close", () => {
      clearInterval(timer);
      if (group.control === socket) group.control = undefined;
    });
  }

  #onControlLine(code: string, socket: Duplex, line: string): void {
    const message = parseControlMessage(line);
    if (message === undefined) return;
    if (message.type === "ping") socket.write(`${JSON.stringify({ type: "pong" })}\n`);
    else if (message.type === "passage-list") this.setList(code, message.keys);
  }

  /**
   * Новый перечень действует сразу: склейки и ожидания с ушедшими Ключами станций закрываются
   * (STATION-17). Склейка по ключу Прохода Приглашения доживает до конца приёма: Приглашение уходит из
   * перечня именно потому, что по нему приняли Станцию, а использованное или отменённое Приглашение
   * Опорная станция всё равно отклонит (STATION-16, STATION-44).
   */
  setList(code: string, keys: PassageKeyEntry[]): void {
    const group = this.#group(code);
    group.keys = new Map(keys.map((k) => [k.key, k]));
    for (const splice of group.splices) {
      if (splice.kind === "station" && !group.keys.has(splice.key)) {
        splice.station.destroy();
        splice.base.destroy();
        group.splices.delete(splice);
      }
    }
    for (const [callId, pending] of group.pending) {
      if (pending.kind === "station" && !group.keys.has(pending.key)) {
        clearTimeout(pending.timer);
        pending.socket.destroy();
        group.pending.delete(callId);
      }
    }
  }

  #keyAllowed(group: GroupPassage, key: string): boolean {
    const entry = group.keys.get(key);
    if (entry === undefined) return false;
    if (entry.kind === "invitation") return Date.parse(entry.expiresAt) > Date.now();
    return true;
  }

  #stationConnect(code: string, req: IncomingMessage, socket: Duplex): void {
    const group = this.#groups.get(code);
    const key = header(req, PASSAGE_KEY_HEADER) ?? "";
    const challengeText = header(req, PASSAGE_CHALLENGE_HEADER) ?? "";
    const challenge = decodeBytes(challengeText, 32);
    const signature = decodeBytes(header(req, PASSAGE_SIGNATURE_HEADER) ?? "", 64);
    const valid =
      group !== undefined &&
      group.control !== undefined &&
      challenge !== undefined &&
      signature !== undefined &&
      this.#keyAllowed(group, key) &&
      this.#challenges.check(challengeText, true) &&
      ed25519Verify(key, passageMessage(code, challenge), signature);
    if (!valid) {
      this.#counters.add("refusals");
      return refuse(socket, 403, "forbidden");
    }
    const callId = randomBytes(16).toString("base64url");
    socket.pause();
    const timer = setTimeout(() => {
      group.pending.delete(callId);
      socket.destroy();
    }, this.#timers.spliceWait);
    group.pending.set(callId, { socket, key, kind: group.keys.get(key)!.kind, timer });
    socket.once("close", () => {
      clearTimeout(timer);
      group.pending.delete(callId);
    });
    group.control!.write(`${JSON.stringify({ type: "call", callId })}\n`);
  }

  #accept(code: string, callId: string, req: IncomingMessage, base: Duplex): void {
    const group = this.#groups.get(code);
    const pending = group?.pending.get(callId);
    if (this.#tokens.codeOf(bearer(req)) !== code || group === undefined || pending === undefined) {
      return refuse(base, 403, "forbidden");
    }
    clearTimeout(pending.timer);
    group.pending.delete(callId);
    const station = pending.socket;
    switching(station, UPGRADE_PASSAGE);
    switching(base, UPGRADE_PASSAGE);
    const splice: Splice = { key: pending.key, kind: pending.kind, station, base };
    group.splices.add(splice);
    const close = () => {
      group.splices.delete(splice);
      station.destroy();
      base.destroy();
    };
    station.once("close", close);
    base.once("close", close);
    station.pipe(base);
    base.pipe(station);
    station.resume();
    this.#counters.add("splices");
  }

  /** Закрыть все соединения — остановка Ретранслятора; новые Upgrade после этого не принимаются. */
  close(): void {
    this.#closed = true;
    for (const group of this.#groups.values()) {
      if (group.pingTimer !== undefined) clearInterval(group.pingTimer);
      group.control?.destroy();
      for (const pending of group.pending.values()) {
        clearTimeout(pending.timer);
        pending.socket.destroy();
      }
      for (const splice of group.splices) {
        splice.station.destroy();
        splice.base.destroy();
      }
    }
    this.#groups.clear();
  }

  /** Есть ли управляющее соединение Группы — для статуса и тестов. */
  hasControl(code: string): boolean {
    return this.#groups.get(code)?.control !== undefined;
  }

  /** Число склеенных соединений с этим ключом — для тестов отзыва (SC-002 фичи 004). */
  splicesOf(code: string, key: string): number {
    return [...(this.#groups.get(code)?.splices ?? [])].filter((s) => s.key === key).length;
  }

  /** Перечень Прохода Группы — для тестов. */
  listOf(code: string): PassageKeyEntry[] {
    return [...(this.#groups.get(code)?.keys.values() ?? [])];
  }
}
