// Файл ключа Ed25519 под паролем: age со scrypt в ASCII armor. Два вида — Ключ Координатора на
// носителе Старшего, не в каталоге данных Опорной станции (NET-14, NET-40; research R6, R7, R14 фичи
// 003), и Ключ станции в каталоге данных Станции под паролем Члена Группы (STATION-09; research R13
// фичи 004). Секретная часть не покидает процесс, который открыл файл.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { Decrypter, Encrypter, armor } from "age-encryption";
import { encodeKey, message } from "@aristotel/protocol";
import { restrictToOwner } from "../install/install.ts";

export const KEY_FILE_FORMAT = "aristotel/klyuch-koordinatora/v1";
export const STATION_KEY_FORMAT = "aristotel/klyuch-stancii/v1";
export type KeyFileFormat = typeof KEY_FILE_FORMAT | typeof STATION_KEY_FORMAT;

/** Множитель scrypt по умолчанию; меньший — только параметром функции из тестов (research R14). */
export const DEFAULT_WORK_FACTOR = 18;

type KeyFileErrorCode = "inside_data_dir" | "exists" | "no_dir" | "wrong_password" | "unreadable";

export class KeyFileError extends Error {
  readonly code: KeyFileErrorCode;
  /** Пути к файлам ключей в текст не попадают (research R15 фичи 003). */
  constructor(code: KeyFileErrorCode, format: KeyFileFormat = KEY_FILE_FORMAT) {
    const station = format === STATION_KEY_FORMAT && (code === "wrong_password" || code === "unreadable" || code === "exists");
    super(message(station ? `station_key_${code as "wrong_password" | "unreadable" | "exists"}` : `key_file_${code}`));
    this.code = code;
  }
}

export interface CoordinatorKey {
  publicKey: string;
  pkcs8: string;
  sign: (data: Uint8Array) => Uint8Array;
}

/** Открытый файл ключа: та же форма у Ключа Координатора и Ключа станции. */
export type OpenedKey = CoordinatorKey;

function realDir(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function isBaseStationDir(dir: string): boolean {
  const install = join(dir, "install.json");
  if (!existsSync(install)) return false;
  try {
    return (JSON.parse(readFileSync(install, "utf8")) as { role?: unknown }).role === "base-station";
  } catch {
    return false;
  }
}

/**
 * Файл попал бы в каталог данных Опорной станции: каталог файла совпадает с каталогом данных или
 * лежит внутри него, либо в нём или выше по дереву лежит install.json роли base-station.
 */
export function insideDataDir(path: string, dataDir: string): boolean {
  const dir = realDir(dirname(resolve(path)));
  if (dir === undefined) return false;
  const data = realDir(resolve(dataDir));
  if (data !== undefined && (dir === data || dir.startsWith(data + sep))) return true;
  for (let current = dir; ; current = dirname(current)) {
    if (isBaseStationDir(current)) return true;
    if (current === parse(current).root) return false;
  }
}

function publicKeyOf(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x: string };
  return encodeKey(Buffer.from(jwk.x, "base64url"));
}

/**
 * Куда можно положить новый файл ключа: каталог есть, он не каталог данных Опорной станции, файла
 * ещё нет. CLI зовёт это до пароля и scrypt (T062), createKeyFile — ещё раз перед записью.
 */
export function checkKeyFileTarget(path: string, dataDir: string): void {
  const dir = dirname(resolve(path));
  if (realDir(dir) === undefined) throw new KeyFileError("no_dir");
  if (insideDataDir(path, dataDir)) throw new KeyFileError("inside_data_dir");
  if (existsSync(path)) throw new KeyFileError("exists");
}

/**
 * Завести ключ: файл создаётся заново (не перезаписывается) с правами 0600. Ключ Координатора не
 * кладётся в каталог данных Опорной станции (NET-14); Ключ станции лежит в каталоге данных Станции.
 */
export async function createKeyFile(
  path: string,
  password: string,
  options: { dataDir: string; workFactor?: number; format?: KeyFileFormat; privateKey?: KeyObject },
): Promise<{ publicKey: string }> {
  const format = options.format ?? KEY_FILE_FORMAT;
  if (format === KEY_FILE_FORMAT) checkKeyFileTarget(path, options.dataDir);
  else if (existsSync(path)) throw new KeyFileError("exists", format);
  const privateKey = options.privateKey ?? generateKeyPairSync("ed25519").privateKey;
  const publicKey = publicKeyOf(privateKey);
  const content = JSON.stringify({
    format,
    pkcs8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey,
    createdAt: new Date().toISOString(),
  });
  const encrypter = new Encrypter();
  encrypter.setPassphrase(password);
  encrypter.setScryptWorkFactor(options.workFactor ?? DEFAULT_WORK_FACTOR);
  const text = armor.encode(await encrypter.encrypt(content));
  try {
    writeFileSync(path, text, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new KeyFileError("exists", format);
    throw error;
  }
  chmodSync(path, 0o600);
  // На Windows режим не снимает унаследованных разрешений — ACL только владельцу, как у access-token.
  restrictToOwner(path);
  return { publicKey };
}

/** Открыть ключ паролем; неверный пароль и испорченный файл — разные отказы. */
export async function readKeyFile(path: string, password: string, format: KeyFileFormat = KEY_FILE_FORMAT): Promise<OpenedKey> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new KeyFileError("unreadable", format);
  }
  return await openKeyText(text, password, format);
}

/** Открыть содержимое файла ключа паролем — файл уже прочитан (подпись в интерфейсе, NET-14). */
export async function openKeyText(text: string, password: string, format: KeyFileFormat = KEY_FILE_FORMAT): Promise<OpenedKey> {
  let encrypted: Uint8Array;
  try {
    encrypted = armor.decode(text);
  } catch {
    throw new KeyFileError("unreadable", format);
  }
  let content: string;
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(password);
    content = new TextDecoder().decode(await decrypter.decrypt(encrypted));
  } catch {
    throw new KeyFileError("wrong_password", format);
  }
  try {
    const parsed = JSON.parse(content) as { format?: unknown; pkcs8?: unknown; publicKey?: unknown };
    if (parsed.format !== format || typeof parsed.pkcs8 !== "string") throw new Error("format");
    const key = createPrivateKey({ key: Buffer.from(parsed.pkcs8, "base64"), format: "der", type: "pkcs8" });
    const publicKey = publicKeyOf(key);
    if (key.asymmetricKeyType !== "ed25519" || parsed.publicKey !== publicKey) throw new Error("format");
    return { publicKey, pkcs8: parsed.pkcs8, sign: (data) => new Uint8Array(sign(null, data, key)) };
  } catch {
    throw new KeyFileError("unreadable", format);
  }
}
