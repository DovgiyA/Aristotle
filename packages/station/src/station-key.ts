// Ключ станции: Ed25519, создаётся на Станции и не покидает её; файл station-key.age под паролем
// Члена Группы (scrypt 2^18); открывается паролем при запуске локальной части (STATION-09, STATION-11;
// research R13 фичи 004). Секретную часть держит только этот модуль — наружу отдаёт подпись.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { STATION_KEY_FORMAT, createKeyFile, readKeyFile } from "@aristotel/core";
import { ed25519FromSeed, ed25519Sign, publicKeyText } from "@aristotel/protocol";
import { stationKeyPath } from "./station-files.ts";

export interface StationKey {
  publicKey: string;
  sign: (message: Uint8Array) => Uint8Array;
}

/** Новый Ключ станции в памяти — файл пишется только после приёма (research R7). */
export function generateStationKey(): { key: KeyObject; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { key: privateKey, publicKey: publicKeyText(privateKey) };
}

export function keyFromSeed(seed: Uint8Array): { key: KeyObject; publicKey: string } {
  const key = ed25519FromSeed(seed);
  return { key, publicKey: publicKeyText(key) };
}

export function signerOf(key: KeyObject): StationKey {
  return { publicKey: publicKeyText(key), sign: (message) => ed25519Sign(key, message) };
}

/** Записать Ключ станции под паролем Члена Группы; файл не перезаписывается. */
export async function writeStationKey(dataDir: string, key: KeyObject, password: string, workFactor?: number): Promise<void> {
  const options: Parameters<typeof createKeyFile>[2] = { dataDir, format: STATION_KEY_FORMAT, privateKey: key };
  if (workFactor !== undefined) options.workFactor = workFactor;
  await createKeyFile(stationKeyPath(dataDir), password, options);
}

/** Открыть Ключ станции паролем; неверный пароль — KeyFileError wrong_password. */
export async function openStationKey(dataDir: string, password: string): Promise<StationKey> {
  const opened = await readKeyFile(stationKeyPath(dataDir), password, STATION_KEY_FORMAT);
  return { publicKey: opened.publicKey, sign: opened.sign };
}
