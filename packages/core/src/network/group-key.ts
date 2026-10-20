// Ключ Группы: пара подписи Ed25519 и идентичность age X25519 создаются службой Опорной станции и
// живут только у неё (NET-01, NET-02). Секретная часть — в файле group-key.json каталога данных, вне
// БД (BANK-52); в БД — открытые части. Без файла при применённом Реестре новый ключ не создаётся —
// Ключ Группы «недоступен», остальной Банк работает (NET-53). Секретную часть этот модуль наружу не
// отдаёт: только «подписать» (research R1–R3, R10 фичи 003).
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUIDv7, sign, type KeyObject } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeKey, keyFingerprint, type GroupKeyInfo } from "@aristotel/protocol";
import { ageRecipientOf, generateAgeIdentity } from "./age-identity.ts";
import { inTransaction, type Db } from "../db/open.ts";
import { restrictToOwner } from "../install/install.ts";
import { ApiError } from "../api/errors.ts";

const FILE = "group-key.json";
const FORMAT = "aristotel/klyuch-gruppy/v1";

export function groupKeyPath(dataDir: string): string {
  return join(dataDir, FILE);
}

interface GroupKeyRow {
  id: string;
  signingKey: string;
  encryptionKey: string;
  keyFingerprint: string;
  createdAt: string;
}

interface Loaded {
  signing: KeyObject;
  signingKey: string;
  encryptionKey: string;
}

/** Ключ Группы службы: открытые части и подпись; секретная часть не выдаётся. */
export class GroupKeyHandle {
  readonly #row: GroupKeyRow | undefined;
  readonly #signing: KeyObject | undefined;

  constructor(row: GroupKeyRow | undefined, signing: KeyObject | undefined) {
    this.#row = row;
    this.#signing = signing;
  }

  /** Секретная часть на месте и совпадает с открытыми частями в БД. */
  get available(): boolean {
    return this.#signing !== undefined;
  }

  /** Открытые части; строки Ключа Группы нет совсем — 409 group_key_unavailable. */
  info(): GroupKeyInfo {
    if (this.#row === undefined) throw new ApiError("group_key_unavailable");
    return {
      signingKey: this.#row.signingKey,
      encryptionKey: this.#row.encryptionKey,
      keyFingerprint: this.#row.keyFingerprint,
      createdAt: this.#row.createdAt,
      state: this.available ? "available" : "unavailable",
    };
  }

  /** Отказ 409 group_key_unavailable, если секретной части нет (NET-53). */
  assertAvailable(): void {
    if (!this.available) throw new ApiError("group_key_unavailable");
  }

  /** Подписать сообщение ключом подписи Ключа Группы (NET-02). */
  sign(message: Uint8Array): Uint8Array {
    if (this.#signing === undefined) throw new ApiError("group_key_unavailable");
    return new Uint8Array(sign(null, message, this.#signing));
  }
}

function currentRow(db: Db): GroupKeyRow | undefined {
  const row = db.prepare("SELECT id, signingKey, encryptionKey, keyFingerprint, createdAt FROM group_key WHERE current = 1").get();
  if (row === undefined) return undefined;
  return {
    id: String(row["id"]),
    signingKey: String(row["signingKey"]),
    encryptionKey: String(row["encryptionKey"]),
    keyFingerprint: String(row["keyFingerprint"]),
    createdAt: String(row["createdAt"]),
  };
}

function publicSigningKey(signing: KeyObject): string {
  const jwk = createPublicKey(signing).export({ format: "jwk" }) as { x: string };
  return encodeKey(Buffer.from(jwk.x, "base64url"));
}

/** Прочитать файл; нет файла или он не читается — undefined. Синхронно: вызывается в транзакции. */
function loadFile(dataDir: string): Loaded | undefined {
  try {
    const file = JSON.parse(readFileSync(groupKeyPath(dataDir), "utf8")) as Record<string, unknown>;
    const signingPart = file["signing"] as { pkcs8?: unknown } | undefined;
    const encryptionPart = file["encryption"] as { identity?: unknown } | undefined;
    if (file["format"] !== FORMAT || typeof signingPart?.pkcs8 !== "string" || typeof encryptionPart?.identity !== "string") return undefined;
    const signing = createPrivateKey({ key: Buffer.from(signingPart.pkcs8, "base64"), format: "der", type: "pkcs8" });
    if (signing.asymmetricKeyType !== "ed25519") return undefined;
    const encryptionKey = ageRecipientOf(encryptionPart.identity);
    if (encryptionKey === undefined) return undefined;
    return { signing, signingKey: publicSigningKey(signing), encryptionKey };
  } catch {
    return undefined;
  }
}

/**
 * Записать файл целиком: временный файл с правами только у службы, затем link — файл появляется
 * готовым и не перезаписывает чужой (как install.json); если файл есть (испорчен или не тот) —
 * атомарная замена через rename. Вызывается только под блокировкой записи БД (research R3, T069).
 */
function writeFile(dataDir: string, content: string): void {
  const path = groupKeyPath(dataDir);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    restrictToOwner(temp);
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      renameSync(temp, path);
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // после rename временного файла уже нет
    }
  }
}

function registryApplied(db: Db): boolean {
  return db.prepare("SELECT 1 AS x FROM registry_version LIMIT 1").get() !== undefined;
}

function createdWithCurrentSchema(db: Db): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'createdWithSchema'").get();
  return row !== undefined && Number(row["value"]) >= 3;
}

function journalService(db: Db, action: string, subjectId: string, details: Record<string, unknown>): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, NULL, ?, 'group-key', ?, ?)").run(
    new Date().toISOString(),
    action,
    subjectId,
    JSON.stringify(details),
  );
}

type Reason = "install" | "upgrade" | "lost";

/** Строка нового текущего ключа и запись журнала group-key.create (в транзакции вызывающего). */
function insertKey(db: Db, loaded: Loaded, createdAt: string, reason: Reason): GroupKeyRow {
  const row: GroupKeyRow = {
    id: randomUUIDv7(),
    signingKey: loaded.signingKey,
    encryptionKey: loaded.encryptionKey,
    keyFingerprint: keyFingerprint(loaded.signingKey),
    createdAt,
  };
  db.prepare("UPDATE group_key SET current = 0 WHERE current = 1").run();
  db.prepare(
    "INSERT INTO group_key (id, signingKey, encryptionKey, keyFingerprint, createdAt, reason, current) VALUES (?, ?, ?, ?, ?, ?, 1)",
  ).run(row.id, row.signingKey, row.encryptionKey, row.keyFingerprint, row.createdAt, reason);
  journalService(db, "group-key.create", row.id, { reason, keyFingerprint: row.keyFingerprint });
  return row;
}

/** Новый ключ: пара Ed25519 и идентичность age X25519 — синхронно, файл пишется сразу. */
function generate(dataDir: string): { loaded: Loaded; createdAt: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const { identity, recipient } = generateAgeIdentity();
  const createdAt = new Date().toISOString();
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  writeFile(dataDir, JSON.stringify({ format: FORMAT, signing: { pkcs8 }, encryption: { identity }, createdAt }, null, 2) + "\n");
  return { loaded: { signing: privateKey, signingKey: publicSigningKey(privateKey), encryptionKey: recipient }, createdAt };
}

/**
 * Запуск службы: Ключ Группы есть и совпадает с БД — взять; нет — создать (install, upgrade, lost);
 * файла нет, он не читается или не совпадает, а Реестр применён, — «недоступен» с записью журнала
 * group-key.unavailable, нового ключа нет (NET-53). Решение, генерация, запись файла и строки — один
 * синхронный участок внутри BEGIN IMMEDIATE: параллельный запуск ждёт блокировку записи БД и затем
 * видит готовые файл и строку (T069).
 */
export async function ensureGroupKey(dataDir: string, db: Db): Promise<GroupKeyHandle> {
  return inTransaction(db, (): GroupKeyHandle => {
    const current = currentRow(db);
    const loaded = loadFile(dataDir);
    if (current !== undefined && loaded !== undefined && loaded.signingKey === current.signingKey && loaded.encryptionKey === current.encryptionKey) {
      return new GroupKeyHandle(current, loaded.signing);
    }
    if (registryApplied(db)) {
      if (current !== undefined) journalService(db, "group-key.unavailable", current.id, { keyFingerprint: current.keyFingerprint });
      return new GroupKeyHandle(current, undefined);
    }
    if (current === undefined && loaded !== undefined) {
      // Файл записан, а строка БД — нет (остановка между ними): ключ тот же, вписать его в БД.
      const reason: Reason = createdWithCurrentSchema(db) ? "install" : "upgrade";
      return new GroupKeyHandle(insertKey(db, loaded, new Date().toISOString(), reason), loaded.signing);
    }
    const reason: Reason = current !== undefined ? "lost" : createdWithCurrentSchema(db) ? "install" : "upgrade";
    const fresh = generate(dataDir);
    return new GroupKeyHandle(insertKey(db, fresh.loaded, fresh.createdAt, reason), fresh.loaded.signing);
  });
}
