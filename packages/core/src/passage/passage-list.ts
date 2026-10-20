// Перечень Прохода: открытые Ключи станций — действующих и в «только удаление» — и ключи Прохода
// действующих Приглашений; Опорная станция шлёт его каждому Ретранслятору при входе и при каждом
// изменении (STATION-04, STATION-22, STATION-44; research R5, R7, R11 фичи 004).
import type { PassageKeyEntry } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import { networkEvents } from "../network/events.ts";

export function passageList(db: Db, now: Date = new Date()): PassageKeyEntry[] {
  const at = now.toISOString();
  const entries: PassageKeyEntry[] = [];
  for (const row of db
    .prepare(
      `SELECT publicKey, state FROM station
       WHERE state = 'active' OR (deleteOnlyUntil > ? AND deletionConfirmedAt IS NULL)
       ORDER BY rowid`,
    )
    .all(at)) {
    entries.push({ key: String(row["publicKey"]), kind: "station", state: row["state"] === "active" ? "active" : "delete-only" });
  }
  for (const row of db.prepare("SELECT passageKey, expiresAt FROM invitation WHERE state = 'issued' AND expiresAt > ? ORDER BY rowid").all(at)) {
    entries.push({ key: String(row["passageKey"]), kind: "invitation", expiresAt: String(row["expiresAt"]) });
  }
  return entries;
}

/** Перечень изменился — разослать всем Проходам (зовётся после фиксации транзакции). */
export function broadcastPassageList(): void {
  networkEvents.emit("passage-list-changed");
}
