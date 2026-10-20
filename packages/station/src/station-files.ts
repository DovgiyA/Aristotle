// Файлы каталога данных Станции (data-model.md фичи 004): station.json — Код Группы, Станция, Член
// Группы, закреплённый отпечаток TLS Опорной станции, текущие Проходы; права — только владелец.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restrictToOwner } from "@aristotel/core";

export const STATION_FILE = "station.json";
export const STATION_KEY_FILE = "station-key.age";

export interface StationState {
  code: string;
  stationId: string;
  /** Установка Опорной станции (доказательство владения Ключом Координатора, фича 003). */
  baseInstallId: string;
  memberId: string;
  memberLabel: string;
  role: string;
  /** Отпечаток TLS Опорной станции, закреплённый при приёме (STATION-03). */
  baseTlsSpki: string;
  /** Текущий перечень Проходов (STATION-42). */
  passages: string[];
  acceptedAt: string;
  /** Порог простоя интерфейса, минут (STATION-11). */
  idleLockMinutes: number;
}

export function stationKeyPath(dataDir: string): string {
  return join(dataDir, STATION_KEY_FILE);
}

export function isAccepted(dataDir: string): boolean {
  return existsSync(join(dataDir, STATION_FILE)) && existsSync(stationKeyPath(dataDir));
}

export function readStationState(dataDir: string): StationState {
  return JSON.parse(readFileSync(join(dataDir, STATION_FILE), "utf8")) as StationState;
}

export function writeStationState(dataDir: string, state: StationState): void {
  const path = join(dataDir, STATION_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  restrictToOwner(temp);
  renameSync(temp, path);
}

/** Удалить Ключ станции и station.json — команда удаления (STATION-20, STATION-22). */
export function deleteStationFiles(dataDir: string): void {
  rmSync(stationKeyPath(dataDir), { force: true });
  rmSync(join(dataDir, STATION_FILE), { force: true });
}
