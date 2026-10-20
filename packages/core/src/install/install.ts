// Установка: роль задаётся один раз (APP-01), токен локального доступа (research R11),
// сверка Банка с установкой. Файлы — install.json и access-token в каталоге данных.
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUIDv7 } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { API_VERSIONS, DEFAULT_PORT, message, type MessageCode } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";

export const ROLES = ["base-station", "station", "relay"] as const;
export type Role = (typeof ROLES)[number];

/** Ретранслятор: Группа-хозяин, адрес прослушивания и свой адрес https:// (research R3 фичи 004). */
export interface RelayInstall {
  group: string;
  listen: string;
  url: string;
}

export interface Install {
  role: Role;
  installId: string;
  createdAt: string;
  apiVersions: number[];
  /** Порт: API сопровождения Опорной станции или интерфейса Станции на loopback. */
  port: number;
  relay?: RelayInstall;
}

export class InstallError extends Error {
  readonly code: MessageCode;
  constructor(code: MessageCode, params: Record<string, string | number> = {}) {
    super(message(code, params));
    this.code = code;
  }
}

const INSTALL_FILE = "install.json";
const TOKEN_FILE = "access-token";

export function installPath(dir: string): string {
  return join(dir, INSTALL_FILE);
}

export function readInstall(dir: string): Install {
  const path = installPath(dir);
  if (!existsSync(path)) throw new InstallError("install_missing", { dir });
  const install = JSON.parse(readFileSync(path, "utf8")) as Install;
  if (!ROLES.includes(install.role)) throw new InstallError("role_unknown", { role: String(install.role) });
  return install;
}

/** Задать роль установки; второй раз — отказ role_already_set, файлы не меняются. */
export function writeInstall(dir: string, options: { role: Role; port?: number; relay?: RelayInstall }): Install {
  if (!ROLES.includes(options.role)) throw new InstallError("role_unknown", { role: String(options.role) });
  if (existsSync(installPath(dir))) {
    throw new InstallError("role_already_set", { role: readInstall(dir).role });
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const install: Install = {
    role: options.role,
    installId: randomUUIDv7(),
    createdAt: new Date().toISOString(),
    apiVersions: [...API_VERSIONS],
    port: options.port ?? DEFAULT_PORT,
  };
  if (options.relay !== undefined) install.relay = options.relay;
  // Два одновременных init: install.json получает ровно один, второй — отказ role_already_set.
  if (!createAtomically(installPath(dir), JSON.stringify(install, null, 2) + "\n")) {
    throw new InstallError("role_already_set", { role: readInstall(dir).role });
  }
  writeAccessToken(dir);
  return install;
}

/**
 * Создать файл целиком или не создавать: содержимое пишется во временный файл, а link отказывает,
 * если файл уже есть. Читатель никогда не видит недописанный файл. false — файл уже был.
 */
export function createAtomically(path: string, content: string, ownerOnly = false): boolean {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, content, { mode: ownerOnly ? 0o600 : 0o644, flag: "wx" });
  try {
    if (ownerOnly) restrictToOwner(temp);
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

/** Токен локального доступа; если его уже создал параллельный init — оставить тот. */
function writeAccessToken(dir: string): void {
  createAtomically(join(dir, TOKEN_FILE), randomBytes(32).toString("base64url"), true);
}

/** Права на файл — только у учётной записи ОС службы (токен доступа, файл Ключа Группы). */
export function restrictToOwner(path: string): void {
  if (process.platform !== "win32") return;
  // На Windows режим 0o600 не действует: снимаем наследование и оставляем полный доступ владельцу.
  execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], { stdio: "ignore" });
}

/** Создать токен, если init прервался между install.json и токеном. */
export function ensureAccessToken(dir: string): void {
  writeAccessToken(dir);
}

export function readAccessToken(dir: string): string {
  return readFileSync(join(dir, TOKEN_FILE), "utf8").trim();
}

/** Банк должен принадлежать этой установке: роль и installId в meta совпадают с install.json. */
export function checkBankMatchesInstall(db: Db, install: Install): void {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key IN ('role', 'installId')").all();
  const meta = Object.fromEntries(rows.map((r) => [String(r["key"]), String(r["value"])]));
  if (meta["role"] !== install.role) {
    throw new InstallError("install_mismatch", { detail: message("detail_role_mismatch", { bank: meta["role"] ?? "", install: install.role }) });
  }
  if (meta["installId"] !== install.installId) {
    throw new InstallError("install_mismatch", { detail: message("detail_install_id_mismatch") });
  }
}
