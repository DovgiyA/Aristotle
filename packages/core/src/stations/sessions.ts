// Сеансы Станций на Опорной станции: вызов, вход подписью Ключом станции над вызовом и EKM этого
// TLS-соединения, короткий токен с продлением, конец сеанса, проверка сроков; журнал сеансов без
// IP-адресов (STATION-10, STATION-22, STATION-34; contracts/stanciya-v1.md; research R8, R11, R12
// фичи 004). В БД — SHA-256 токена, а не токен.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUIDv7 } from "node:crypto";
import type { TLSSocket } from "node:tls";
import {
  CHALLENGE_TTL_MS,
  SESSION_TTL_MS,
  STATION_EKM_LABEL,
  decodeBytes,
  ed25519Verify,
  encodeBytes,
  stationLoginMessage,
  type Role,
  type SessionRequest,
  type SessionResponse,
  type SessionScope,
} from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";

export interface StationSession {
  sessionId: string;
  stationId: string;
  memberId: string;
  /** Открытый Ключ станции — им проверяются подтверждения присутствия и удаления. */
  stationKey: string;
  scope: SessionScope;
  expiresAt: string;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Сеанс по токену: не истёк, не закрыт, Станция действует или в «только удаление». Нет — 401
 * session_required (contracts/http-api.md «Общие правила»).
 */
export function authenticateSession(db: Db, token: string, now: Date = new Date()): StationSession {
  if (token === "") throw new ApiError("session_required");
  const row = db
    .prepare(
      `SELECT s.id, s.stationId, s.scope, s.expiresAt, st.memberId, st.publicKey
       FROM station_session s JOIN station st ON st.id = s.stationId
       WHERE s.tokenHash = ? AND s.endedAt IS NULL`,
    )
    .get(tokenHash(token));
  if (row === undefined || String(row["expiresAt"]) <= now.toISOString()) throw new ApiError("session_required");
  // Сеанс «только удаление» живёт, пока не вышел срок Группы и удаление не подтверждено (STATION-22).
  if (row["scope"] === "delete-only" && !inDeleteOnly(db, String(row["stationId"]), now)) throw new ApiError("session_required");
  return {
    sessionId: String(row["id"]),
    stationId: String(row["stationId"]),
    memberId: String(row["memberId"]),
    stationKey: String(row["publicKey"]),
    scope: String(row["scope"]) as SessionScope,
    expiresAt: String(row["expiresAt"]),
  };
}

function inDeleteOnly(db: Db, stationId: string, now: Date): boolean {
  const station = db.prepare("SELECT deleteOnlyUntil, deletionConfirmedAt FROM station WHERE id = ?").get(stationId);
  return station !== undefined && station["deleteOnlyUntil"] !== null && String(station["deleteOnlyUntil"]) > now.toISOString() && station["deletionConfirmedAt"] === null;
}

/**
 * Сеанс текущего запроса API Станций: хук кладёт его сюда, а изменяющие функции ядра перепроверяют
 * его первым шагом транзакции вместе с автором — Станцию могут отозвать между хуком и транзакцией
 * (STATION-17, spec Edge Cases фичи 004).
 */
export interface SessionStore {
  session: StationSession | null;
  /** Соединение запроса: его отзыв своей же Станции рвёт после ответа, а не до. */
  socket: TrackedSocket | null;
}
export const sessionContext = new AsyncLocalStorage<SessionStore>();

/** Сеанс запроса ещё открыт и его Станция действует; вне запроса API Станций — ничего не проверяет. */
export function assertSessionOpen(db: Db): void {
  const session = sessionContext.getStore()?.session;
  if (session === null || session === undefined) return;
  const row = db
    .prepare("SELECT 1 FROM station_session s JOIN station st ON st.id = s.stationId WHERE s.id = ? AND s.endedAt IS NULL AND st.state = 'active'")
    .get(session.sessionId);
  if (row === undefined) throw new ApiError("session_required");
}

/**
 * Соединения внутреннего TLS, по которым ходили сеансы Станции: при отзыве служба рвёт их сразу,
 * не дожидаясь конца запросов (STATION-17, SC-002 фичи 004).
 */
export interface TrackedSocket {
  destroy: () => void;
  once: (event: "close", listener: () => void) => unknown;
}

export class StationConnections {
  readonly #byStation = new Map<string, Set<TrackedSocket>>();

  track(stationId: string, socket: TrackedSocket): void {
    let set = this.#byStation.get(stationId);
    if (set === undefined) {
      set = new Set();
      this.#byStation.set(stationId, set);
    }
    if (set.has(socket)) return;
    set.add(socket);
    socket.once("close", () => {
      set.delete(socket);
      if (set.size === 0 && this.#byStation.get(stationId) === set) this.#byStation.delete(stationId);
    });
  }

  /** Разорвать соединения Станции; соединение текущего запроса — после его ответа. */
  close(stationId: string, later?: { socket: TrackedSocket; after: (close: () => void) => void }): void {
    const set = this.#byStation.get(stationId);
    this.#byStation.delete(stationId);
    for (const socket of set ?? []) {
      if (later !== undefined && socket === later.socket) later.after(() => socket.destroy());
      else socket.destroy();
    }
  }
}

function journal(db: Db, actorId: string | null, action: string, stationId: string, details: Record<string, unknown>): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, 'station', ?, ?)").run(
    new Date().toISOString(),
    actorId,
    action,
    stationId,
    JSON.stringify(details),
  );
}

/** Вызовы входа — одноразовые, живут 30 с, только в памяти процесса. */
export class SessionChallenges {
  readonly #items = new Map<string, number>();

  issue(now: number = Date.now()): { challenge: string; expiresAt: string } {
    for (const [key, until] of this.#items) if (until < now) this.#items.delete(key);
    const challenge = encodeBytes(randomBytes(32));
    const until = now + CHALLENGE_TTL_MS;
    this.#items.set(challenge, until);
    return { challenge, expiresAt: new Date(until).toISOString() };
  }

  consume(challenge: string, now: number = Date.now()): boolean {
    const until = this.#items.get(challenge);
    this.#items.delete(challenge);
    return until !== undefined && until >= now;
  }
}

/** EKM TLS-соединения запроса; не TLS — undefined: вход без канала невозможен (research R8). */
export function exportEkm(socket: unknown): Uint8Array | undefined {
  const tls = socket as Partial<TLSSocket>;
  if (typeof tls.exportKeyingMaterial !== "function" || tls.encrypted !== true) return undefined;
  return new Uint8Array(tls.exportKeyingMaterial(32, STATION_EKM_LABEL, Buffer.alloc(0)));
}

export interface LoginContext {
  db: Db;
  challenges: SessionChallenges;
  /** Адреса Проходов своей записи (STATION-42). */
  passages: () => string[];
}

/**
 * POST /api/session (STATION-10): подпись Ключом станции над вызовом и EKM; Станция действует —
 * сеанс full, «только удаление» — delete-only, иначе 403 station_unknown. С токеном действующего
 * сеанса той же Станции — продление: тот же sessionId, новый токен, журнал не пишется.
 */
export function login(ctx: LoginContext, request: SessionRequest, ekm: Uint8Array | undefined, currentToken: string, now: Date = new Date()): SessionResponse {
  const challenge = decodeBytes(request.challenge, 32);
  const signature = decodeBytes(request.signature, 64);
  if (ekm === undefined || challenge === undefined || signature === undefined || !ctx.challenges.consume(request.challenge, now.getTime())) {
    throw new ApiError("station_unknown");
  }
  if (!ed25519Verify(request.stationKey, stationLoginMessage(challenge, ekm), signature)) throw new ApiError("station_unknown");
  return inTransaction(ctx.db, () => {
    const station = ctx.db
      .prepare(
        `SELECT s.id, s.memberId, s.state, s.deleteOnlyUntil, s.deletionConfirmedAt, m.role FROM station s
         JOIN member m ON m.id = s.memberId WHERE s.publicKey = ?`,
      )
      .get(request.stationKey);
    if (station === undefined) throw new ApiError("station_unknown");
    const at = now.toISOString();
    let scope: SessionScope;
    if (station["state"] === "active") scope = "full";
    else if (station["deleteOnlyUntil"] !== null && String(station["deleteOnlyUntil"]) > at && station["deletionConfirmedAt"] === null) scope = "delete-only";
    else throw new ApiError("station_unknown");
    const stationId = String(station["id"]);
    const memberId = String(station["memberId"]);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    let sessionId: string | undefined;
    if (currentToken !== "") {
      const current = ctx.db
        .prepare("SELECT id FROM station_session WHERE tokenHash = ? AND stationId = ? AND scope = ? AND endedAt IS NULL AND expiresAt > ?")
        .get(tokenHash(currentToken), stationId, scope, at);
      if (current !== undefined) {
        sessionId = String(current["id"]);
        ctx.db.prepare("UPDATE station_session SET tokenHash = ?, expiresAt = ? WHERE id = ?").run(tokenHash(token), expiresAt, sessionId);
      }
    }
    if (sessionId === undefined) {
      sessionId = randomUUIDv7();
      ctx.db
        .prepare("INSERT INTO station_session (id, stationId, tokenHash, scope, startedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, stationId, tokenHash(token), scope, at, expiresAt);
      journal(ctx.db, memberId, "station.session.start", stationId, { sessionId, scope });
    }
    return { sessionId, token, expiresAt, scope, stationId, memberId, role: String(station["role"]) as Role, passages: ctx.passages() };
  });
}

/** DELETE /api/session — локальная часть вышла (STATION-34). */
export function endSession(db: Db, session: StationSession, now: Date = new Date()): void {
  inTransaction(db, () => endSessionInTx(db, session, now));
}

/** Конец сеанса exit с записью журнала — внутри уже открытой транзакции (выход, подтверждение удаления). */
export function endSessionInTx(db: Db, session: StationSession, now: Date = new Date()): void {
  const changed = db.prepare("UPDATE station_session SET endedAt = ?, endReason = 'exit' WHERE id = ? AND endedAt IS NULL").run(now.toISOString(), session.sessionId);
  if (Number(changed.changes) > 0) journal(db, session.memberId, "station.session.end", session.stationId, { sessionId: session.sessionId, reason: "exit" });
}

/** Закрыть сеансы Станции (отзыв): возвращает число закрытых; журнал — от служба (STATION-17). */
export function endStationSessions(db: Db, stationId: string, reason: "revoked" | "expired", now: Date = new Date()): number {
  const open = db.prepare("SELECT id FROM station_session WHERE stationId = ? AND endedAt IS NULL").all(stationId);
  for (const row of open) {
    db.prepare("UPDATE station_session SET endedAt = ?, endReason = ? WHERE id = ?").run(now.toISOString(), reason, String(row["id"]));
    journal(db, null, "station.session.end", stationId, { sessionId: String(row["id"]), reason });
  }
  return open.length;
}

/** Сроки вышли без продления — конец сеанса expired (раз в минуту и при запуске службы). */
export function expireSessions(db: Db, now: Date = new Date()): number {
  return inTransaction(db, () => {
    const rows = db.prepare("SELECT id, stationId FROM station_session WHERE endedAt IS NULL AND expiresAt <= ?").all(now.toISOString());
    for (const row of rows) {
      db.prepare("UPDATE station_session SET endedAt = ?, endReason = 'expired' WHERE id = ?").run(now.toISOString(), String(row["id"]));
      journal(db, null, "station.session.end", String(row["stationId"]), { sessionId: String(row["id"]), reason: "expired" });
    }
    return rows.length;
  });
}
