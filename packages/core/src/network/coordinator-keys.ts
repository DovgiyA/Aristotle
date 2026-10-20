// Ключи Координатора на Опорной станции: только открытые части с владельцем-Старшим. Ключ
// регистрирует сам Старший с доказательством владения; у действующего Старшего — не больше одного
// ключа; снятый ключ остаётся в применённых версиях до их замены (NET-13, NET-15, FR-016; research R7
// фичи 003). Секретных частей служба не видит (NET-14).
import { randomUUIDv7, verify } from "node:crypto";
import {
  coordinatorKeyProofMessage,
  decodeKey,
  ed25519PublicKey,
  keyFingerprint,
  parseSignedDocument,
  parseRegistryBody,
  REGISTRY_FORMAT,
  type CoordinatorKeyItem,
  type CoordinatorKeyRegisterRequest,
} from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { assertActor } from "../rights/rights.ts";

function decodeSignature(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]{86}$/.test(text)) return undefined;
  const raw = Buffer.from(text, "base64");
  return raw.length === 64 ? new Uint8Array(raw) : undefined;
}

/** Ключи Координатора последней применённой версии Реестра (для inCurrentRegistry). */
export function currentCoordinatorKeys(db: Db): Set<string> {
  const row = db.prepare("SELECT document FROM registry_version ORDER BY number DESC LIMIT 1").get();
  if (row === undefined) return new Set();
  const doc = parseSignedDocument(String(row["document"]), REGISTRY_FORMAT);
  return new Set(parseRegistryBody(doc.body).coordinatorKeys);
}

function toItem(row: Record<string, unknown>, inRegistry: Set<string>): CoordinatorKeyItem {
  return {
    id: String(row["id"]),
    publicKey: String(row["publicKey"]),
    keyFingerprint: String(row["keyFingerprint"]),
    member: { id: String(row["memberId"]), label: String(row["memberLabel"]) },
    state: row["state"] === "withdrawn" ? "withdrawn" : "registered",
    registeredAt: String(row["registeredAt"]),
    withdrawnAt: row["withdrawnAt"] === null ? null : String(row["withdrawnAt"]),
    inCurrentRegistry: inRegistry.has(String(row["publicKey"])),
  };
}

const SELECT = `SELECT k.*, m.label AS memberLabel FROM coordinator_key k JOIN member m ON m.id = k.memberId`;

export function listCoordinatorKeys(db: Db): CoordinatorKeyItem[] {
  const inRegistry = currentCoordinatorKeys(db);
  return db.prepare(`${SELECT} ORDER BY k.rowid`).all().map((row) => toItem(row, inRegistry));
}

function journal(db: Db, actorId: string, action: string, id: string, publicKey: string): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, 'coordinator-key', ?, ?)").run(
    new Date().toISOString(),
    actorId,
    action,
    id,
    JSON.stringify({ keyFingerprint: keyFingerprint(publicKey) }),
  );
}

/** Зарегистрировать ключ за автором запроса; доказательство — подпись над installId и memberId. */
export function registerCoordinatorKey(db: Db, actorId: string, request: CoordinatorKeyRegisterRequest, installId: string): CoordinatorKeyItem {
  return inTransaction(db, () => {
    assertActor(db, actorId, "coordinator-key.register");
    const proof = decodeSignature(request.proof);
    let valid = false;
    if (decodeKey(request.publicKey) !== undefined && proof !== undefined) {
      try {
        valid = verify(null, coordinatorKeyProofMessage(installId, actorId), ed25519PublicKey(request.publicKey), proof);
      } catch {
        valid = false;
      }
    }
    if (!valid) throw new ApiError("coordinator_key_proof_invalid");
    const taken = db.prepare("SELECT 1 AS x FROM coordinator_key WHERE publicKey = ?").get(request.publicKey);
    const own = db.prepare("SELECT 1 AS x FROM coordinator_key WHERE memberId = ? AND state = 'registered'").get(actorId);
    if (taken !== undefined || own !== undefined) throw new ApiError("coordinator_key_exists");
    const id = randomUUIDv7();
    db.prepare(
      "INSERT INTO coordinator_key (id, publicKey, keyFingerprint, memberId, state, registeredAt) VALUES (?, ?, ?, ?, 'registered', ?)",
    ).run(id, request.publicKey, keyFingerprint(request.publicKey), actorId, new Date().toISOString());
    journal(db, actorId, "coordinator-key.register", id, request.publicKey);
    return toItem(db.prepare(`${SELECT} WHERE k.id = ?`).get(id)!, currentCoordinatorKeys(db));
  });
}

/** Снять свой зарегистрированный ключ; применённые версии Реестра не меняются (NET-15). */
export function withdrawCoordinatorKey(db: Db, actorId: string): CoordinatorKeyItem {
  return inTransaction(db, () => {
    assertActor(db, actorId, "coordinator-key.withdraw");
    const row = db.prepare("SELECT id, publicKey FROM coordinator_key WHERE memberId = ? AND state = 'registered'").get(actorId);
    if (row === undefined) throw new ApiError("coordinator_key_missing");
    const id = String(row["id"]);
    db.prepare("UPDATE coordinator_key SET state = 'withdrawn', withdrawnAt = ? WHERE id = ?").run(new Date().toISOString(), id);
    journal(db, actorId, "coordinator-key.withdraw", id, String(row["publicKey"]));
    return toItem(db.prepare(`${SELECT} WHERE k.id = ?`).get(id)!, currentCoordinatorKeys(db));
  });
}
