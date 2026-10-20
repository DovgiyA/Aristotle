// Станции Группы на Опорной станции: вид «Станции» для Старших — состояние, последний сеанс,
// «только удаление» (VIEW-47, STATION-22; data-model.md «station»); отзыв и сдача, отзыв Станций
// отозванного Члена Группы, команда удаления, параметры Группы (STATION-17, STATION-18, STATION-20,
// STATION-22; research R11 фичи 004).
import { randomUUIDv7 } from "node:crypto";
import { decodeBytes, deletionMessage, ed25519Verify, type GroupSettings, type GroupSettingsPatch, type RevokeReason, type StationView } from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { assertActor } from "../rights/rights.ts";
import { networkEvents } from "../network/events.ts";
import { broadcastPassageList } from "../passage/passage-list.ts";
import { endSessionInTx, endStationSessions, type StationSession } from "./sessions.ts";

export function stationView(row: Record<string, unknown>, now: Date = new Date()): StationView {
  const state = String(row["state"]) as "active" | "revoked";
  const deleteOnlyUntil = row["deleteOnlyUntil"] === null ? null : String(row["deleteOnlyUntil"]);
  const confirmed = row["deletionConfirmedAt"] === null ? null : String(row["deletionConfirmedAt"]);
  const view = state === "active" ? "active" : deleteOnlyUntil !== null && deleteOnlyUntil > now.toISOString() && confirmed === null ? "delete-only" : "revoked";
  return {
    id: String(row["id"]),
    memberId: String(row["memberId"]),
    memberLabel: String(row["memberLabel"]),
    keyFingerprint: String(row["keyFingerprint"]),
    acceptedAt: String(row["acceptedAt"]),
    state,
    view,
    lastSession: row["lastStartedAt"] === null ? null : { startedAt: String(row["lastStartedAt"]), endedAt: row["lastEndedAt"] === null ? null : String(row["lastEndedAt"]) },
    revokedAt: row["revokedAt"] === null ? null : String(row["revokedAt"]),
    revokeReason: row["revokeReason"] === null ? null : (String(row["revokeReason"]) as StationView["revokeReason"]),
    deleteOnlyUntil,
    deletionConfirmedAt: confirmed,
  };
}

const SELECT_STATIONS = `
  SELECT s.*, m.label AS memberLabel,
    (SELECT startedAt FROM station_session x WHERE x.stationId = s.id ORDER BY x.startedAt DESC LIMIT 1) AS lastStartedAt,
    (SELECT endedAt FROM station_session x WHERE x.stationId = s.id ORDER BY x.startedAt DESC LIMIT 1) AS lastEndedAt
  FROM station s JOIN member m ON m.id = s.memberId`;

/** GET /api/stations — все Станции Группы, в порядке приёма. */
export function listStations(db: Db, now: Date = new Date()): StationView[] {
  return db.prepare(`${SELECT_STATIONS} ORDER BY s.rowid`).all().map((r) => stationView(r, now));
}

export function getStation(db: Db, id: string, now: Date = new Date()): StationView | undefined {
  const row = db.prepare(`${SELECT_STATIONS} WHERE s.id = ?`).get(id);
  return row === undefined ? undefined : stationView(row, now);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function journal(db: Db, actorId: string | null, action: string, subjectType: string, subjectId: string, details: Record<string, unknown>, at: string): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, ?, ?, ?)").run(
    at,
    actorId,
    action,
    subjectType,
    subjectId,
    JSON.stringify(details),
  );
}

/** Параметры Группы (data-model.md «group_setting»). */
export function readGroupSettings(db: Db): GroupSettings {
  const settings: Record<string, number> = {};
  for (const row of db.prepare("SELECT key, value FROM group_setting").all()) settings[String(row["key"])] = Number(row["value"]);
  return { invitationHours: settings["invitationHours"] ?? 72, deleteOnlyDays: settings["deleteOnlyDays"] ?? 90 };
}

/** PATCH /api/group-settings — Старший; пределы проверяет схема и CHECK таблицы. */
export function updateGroupSettings(db: Db, patch: GroupSettingsPatch, actorId: string, now: Date = new Date()): GroupSettings {
  return inTransaction(db, () => {
    assertActor(db, actorId, "group-setting.update");
    const changes: Record<string, number> = {};
    for (const key of ["invitationHours", "deleteOnlyDays"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      db.prepare("UPDATE group_setting SET value = ? WHERE key = ?").run(value, key);
      changes[key] = value;
    }
    journal(db, actorId, "group-setting.update", "group-setting", "group", changes, now.toISOString());
    return readGroupSettings(db);
  });
}

/** Отозвать в текущей транзакции: состояние, срок «только удаление», сеансы, журнал. */
function revokeInTx(db: Db, stationId: string, reason: RevokeReason, actorId: string, now: Date): void {
  const at = now.toISOString();
  const until = new Date(now.getTime() + readGroupSettings(db).deleteOnlyDays * DAY_MS).toISOString();
  db.prepare("UPDATE station SET state = 'revoked', revokedAt = ?, revokedBy = ?, revokeReason = ?, deleteOnlyUntil = ? WHERE id = ?").run(
    at,
    actorId,
    reason,
    until,
    stationId,
  );
  endStationSessions(db, stationId, "revoked", now);
  journal(db, actorId, "station.revoke", "station", stationId, { reason, deleteOnlyUntil: until }, at);
}

/**
 * После фиксации отзыва: новый перечень всем Проходам и разрыв соединений Станций (не позже 5 с,
 * SC-002 фичи 004). Соединения рвёт API Станций по событию stations-revoked.
 */
export function afterStationsRevoked(stationIds: string[]): void {
  if (stationIds.length === 0) return;
  // Отзыв уже зафиксирован: сбой рассылки или разрыва не должен превратить его в отказ запроса.
  try {
    broadcastPassageList();
    networkEvents.emit("stations-revoked", stationIds);
  } catch {
    // Перечень уйдёт при следующем входе на Ретранслятор; сеансы уже закрыты в БД.
  }
}

/** POST /api/stations/:id/revoke — отзыв или сдача (STATION-17, STATION-20); без присутствия. */
export function revokeStation(db: Db, stationId: string, reason: "revoked" | "handover", actorId: string, now: Date = new Date()): StationView {
  const view = inTransaction(db, () => {
    assertActor(db, actorId, "station.revoke");
    const row = db.prepare("SELECT state FROM station WHERE id = ?").get(stationId);
    if (row === undefined) throw new ApiError("not_found", { id: stationId }, {}, "station_not_found");
    if (row["state"] !== "active") throw new ApiError("station_not_active");
    revokeInTx(db, stationId, reason, actorId, now);
    return getStation(db, stationId, now)!;
  });
  afterStationsRevoked([stationId]);
  return view;
}

/**
 * Отзыв Члена Группы отзывает его действующие Станции в той же транзакции (STATION-18); зовётся
 * изнутри транзакции отзыва Члена Группы, рассылку после фиксации делает вызывающий.
 */
export function revokeMemberStationsInTx(db: Db, memberId: string, actorId: string, now: Date = new Date()): string[] {
  const ids = db.prepare("SELECT id FROM station WHERE memberId = ? AND state = 'active' ORDER BY rowid").all(memberId).map((r) => String(r["id"]));
  for (const id of ids) revokeInTx(db, id, "member-revoked", actorId, now);
  return ids;
}

/** Команды удаления — по одной на Станцию, в памяти процесса службы (contracts/stanciya-v1.md). */
export class DeletionCommands {
  readonly #byStation = new Map<string, string>();

  /** GET /api/station/deletion: команда сеанса «только удаление». */
  issue(session: StationSession): { commandId: string; items: string[] } {
    let commandId = this.#byStation.get(session.stationId);
    if (commandId === undefined) {
      commandId = randomUUIDv7();
      this.#byStation.set(session.stationId, commandId);
    }
    // Рабочие копии и офлайн-черновики добавит фича 009.
    return { commandId, items: ["station-key"] };
  }

  /**
   * POST /api/station/deletion/confirm: подпись Ключом станции над командой; журнал от службы,
   * сеанс закрыт (STATION-22). Перечень Прохода без ключа рассылает маршрут — после ответа: иначе
   * Ретранслятор закроет склейку раньше, чем ответ дойдёт до Станции.
   */
  confirm(db: Db, session: StationSession, commandId: string, signatureText: string, now: Date = new Date()): void {
    const signature = decodeBytes(signatureText, 64);
    const expected = this.#byStation.get(session.stationId);
    if (expected === undefined || expected !== commandId || signature === undefined || !ed25519Verify(session.stationKey, deletionMessage(session.stationId, commandId), signature)) {
      throw new ApiError("station_unknown");
    }
    const at = now.toISOString();
    inTransaction(db, () => {
      const changed = db.prepare("UPDATE station SET deletionConfirmedAt = ? WHERE id = ? AND state = 'revoked' AND deletionConfirmedAt IS NULL").run(at, session.stationId);
      if (Number(changed.changes) === 0) throw new ApiError("station_unknown");
      endSessionInTx(db, session, now);
      journal(db, null, "station.deletion.confirm", "station", session.stationId, { commandId, items: ["station-key"] }, at);
    });
    this.#byStation.delete(session.stationId);
  }
}

/**
 * Сроки «только удаление», вышедшие в (from, to]: ключи уходят из перечня — разослать его; сеансы
 * delete-only этих Станций закрываются как expired (проверка раз в час и при запуске службы).
 */
export function expireDeleteOnly(db: Db, from: Date, to: Date = new Date()): number {
  const rows = db
    .prepare("SELECT id FROM station WHERE state = 'revoked' AND deletionConfirmedAt IS NULL AND deleteOnlyUntil > ? AND deleteOnlyUntil <= ?")
    .all(from.toISOString(), to.toISOString());
  if (rows.length === 0) return 0;
  inTransaction(db, () => {
    for (const row of rows) endStationSessions(db, String(row["id"]), "expired", to);
  });
  afterStationsRevoked(rows.map((r) => String(r["id"])));
  return rows.length;
}
