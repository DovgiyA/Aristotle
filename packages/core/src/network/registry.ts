// Реестр Сети на Опорной станции: черновик следующей версии, применение подписанной версии,
// развилка и её снятие, чтение. Документ — aristotel/reestr/v1 (contracts/reestr-v1.md). В этой
// версии программы Реестр несёт одну запись — свою Группу, она же Координирующая (FR-014);
// записи других Групп, Приостановка и исключение — фича 019 (research R8–R10 фичи 003).
import { randomUUIDv7 } from "node:crypto";
import {
  REGISTRY_FORMAT,
  RegistryFormatError,
  SignedDocumentError,
  bodySha256,
  checkSuccessor,
  isGroupCode,
  isRelayUrl,
  decodeKey,
  keyFingerprint,
  message,
  parseRegistryBody,
  parseSignedDocument,
  serializeSignedDocument,
  signerAmong,
  MAX_RELAYS,
  type DraftRequest,
  type MessageCode,
  type RegistryBody,
  type RegistryConflict,
  type RegistryCurrent,
  type RegistryState,
  type Relay,
  type SignedDocument,
} from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { assertActor } from "../rights/rights.ts";
import type { GroupKeyHandle } from "./group-key.ts";
import { networkEvents } from "./events.ts";

/** Причины отказа registry_rejected (contracts/http-api.md). */
export type RejectReason =
  | "format"
  | "code_format"
  | "signature"
  | "unsigned"
  | "group_key_mismatch"
  | "code_changed"
  | "no_relay"
  | "foreign_groups"
  | "own_state"
  | "not_coordinating"
  | "coordinator_key_unbound";

function rejected(reason: RejectReason): ApiError {
  return new ApiError("registry_rejected", { reason: message(`reason_${reason}` as MessageCode) }, { reason });
}

interface Applied {
  number: number;
  doc: SignedDocument;
  body: RegistryBody;
  bodySha256: string;
  signedBy: string;
  appliedAt: string;
  /** NULL — служба: версию отдал Ретранслятор при входе (RELAY-18, фича 004). */
  appliedBy: string | null;
  appliedByLabel: string;
}

function readApplied(row: Record<string, unknown>): Applied {
  const doc = parseSignedDocument(String(row["document"]), REGISTRY_FORMAT);
  return {
    number: Number(row["number"]),
    doc,
    body: parseRegistryBody(doc.body),
    bodySha256: String(row["bodySha256"]),
    signedBy: String(row["signedBy"]),
    appliedAt: String(row["appliedAt"]),
    appliedBy: row["appliedBy"] === null ? null : String(row["appliedBy"]),
    appliedByLabel: row["appliedBy"] === null ? message("actor_service") : String(row["appliedByLabel"]),
  };
}

const SELECT_APPLIED = `SELECT v.*, m.label AS appliedByLabel FROM registry_version v LEFT JOIN member m ON m.id = v.appliedBy`;

function lastApplied(db: Db): Applied | undefined {
  const row = db.prepare(`${SELECT_APPLIED} ORDER BY v.number DESC LIMIT 1`).get();
  return row === undefined ? undefined : readApplied(row);
}

function appliedNumber(db: Db, number: number): Applied | undefined {
  const row = db.prepare(`${SELECT_APPLIED} WHERE v.number = ?`).get(number);
  return row === undefined ? undefined : readApplied(row);
}

/** Применённая версия с наибольшим номером меньше данного — ею проверяется подпись развилки. */
function appliedBefore(db: Db, number: number): Applied | undefined {
  const row = db.prepare(`${SELECT_APPLIED} WHERE v.number < ? ORDER BY v.number DESC LIMIT 1`).get(number);
  return row === undefined ? undefined : readApplied(row);
}

function isHalted(db: Db): boolean {
  return db.prepare("SELECT 1 AS x FROM registry_conflict WHERE resolvedBy IS NULL LIMIT 1").get() !== undefined;
}

/** Ключи Координатора, зарегистрированные за действующими Старшими, в порядке регистрации. */
function boundKeys(db: Db): { publicKey: string; memberId: string }[] {
  return db
    .prepare(
      `SELECT k.publicKey, k.memberId FROM coordinator_key k JOIN member m ON m.id = k.memberId
       WHERE k.state = 'registered' AND m.role = 'senior' AND m.state = 'active' ORDER BY k.rowid`,
    )
    .all()
    .map((r) => ({ publicKey: String(r["publicKey"]), memberId: String(r["memberId"]) }));
}

/** Подпись версии 1: ключом из неё же, зарегистрированным за действующим Старшим (research R9). */
function firstVersionSigner(db: Db, doc: SignedDocument, body: RegistryBody): string | undefined {
  const bound = new Set(boundKeys(db).map((k) => k.publicKey));
  return signerAmong(
    doc,
    body.coordinatorKeys.filter((k) => bound.has(k)),
  );
}

function currentView(applied: Applied): RegistryCurrent {
  return {
    number: applied.number,
    bodySha256: applied.bodySha256,
    appliedAt: applied.appliedAt,
    appliedBy: { id: applied.appliedBy, label: applied.appliedByLabel },
    signedBy: { key: applied.signedBy, keyFingerprint: keyFingerprint(applied.signedBy) },
    body: applied.body,
    coordinatorKeyFingerprints: applied.body.coordinatorKeys.map(keyFingerprint),
  };
}

/** GET /api/registry: действующая версия, остановка, развилки. */
export function registryState(db: Db): RegistryState {
  const last = lastApplied(db);
  const conflicts: RegistryConflict[] = db
    .prepare("SELECT number, bodySha256, receivedAt, resolvedBy FROM registry_conflict ORDER BY rowid")
    .all()
    .map((r) => ({
      number: Number(r["number"]),
      bodySha256: String(r["bodySha256"]),
      receivedAt: String(r["receivedAt"]),
      resolvedBy: r["resolvedBy"] === null ? null : Number(r["resolvedBy"]),
    }));
  return { current: last === undefined ? null : currentView(last), halted: isHalted(db), conflicts };
}

/** Применённая версия как хранится; нет такой — undefined. */
export function registryDocumentText(db: Db, number: number): string | undefined {
  const row = db.prepare("SELECT document FROM registry_version WHERE number = ?").get(number);
  return row === undefined ? undefined : String(row["document"]);
}

/** Доверять Ключу Группы — только если он стоит в последней применённой версии (NET-07). */
export function isTrustedGroupKey(db: Db, signingKey: string): boolean {
  const last = lastApplied(db);
  return last !== undefined && last.body.groups.some((g) => g.signingKey === signingKey && g.state === "active");
}

function checkRelay(relay: Relay): void {
  if (!isRelayUrl(relay.url) || decodeKey(relay.tlsSpki) === undefined) throw rejected("format");
}

/** POST /api/registry/draft: неподписанный документ следующей версии (research R8). */
export function buildDraft(db: Db, groupKey: GroupKeyHandle, request: DraftRequest): SignedDocument {
  const last = lastApplied(db);
  const own = last?.body.groups[0];
  let code: string;
  if (own === undefined) {
    if (request.code === undefined || !isGroupCode(request.code)) throw rejected("code_format");
    code = request.code;
  } else {
    if (request.code !== undefined && request.code !== own.code) throw rejected("code_changed");
    code = own.code;
  }
  const relays: Relay[] = own === undefined ? [] : [...own.relays];
  for (const relay of request.addRelays ?? []) {
    checkRelay(relay);
    const existing = relays.findIndex((r) => r.url === relay.url);
    if (existing === -1) relays.push(relay);
    else relays[existing] = relay;
  }
  const removed = new Set(request.removeRelays ?? []);
  const kept = relays.filter((r) => !removed.has(r.url));
  if (kept.length === 0) throw rejected("no_relay");
  if (kept.length > MAX_RELAYS) throw rejected("format");
  const coordinatorKeys = boundKeys(db).map((k) => k.publicKey);
  if (coordinatorKeys.length === 0) throw new ApiError("coordinator_key_missing");
  const info = groupKey.info();
  const body = JSON.stringify({
    number: (last?.number ?? 0) + 1,
    issuedAt: new Date().toISOString(),
    coordinatingGroup: code,
    coordinatorKeys,
    groups: [{ code, signingKey: info.signingKey, encryptionKey: info.encryptionKey, state: "active", relays: kept }],
  });
  parseRegistryBody(body);
  return { format: REGISTRY_FORMAT, body, signatures: [] };
}

function journal(db: Db, actorId: string | null, action: string, number: number | undefined, details: Record<string, unknown>): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, 'registry', ?, ?)").run(
    new Date().toISOString(),
    actorId,
    action,
    number === undefined ? "?" : String(number),
    JSON.stringify(details),
  );
}

/** Проверки содержимого версии (research R9, шаг 6). */
function checkContent(db: Db, groupKey: GroupKeyHandle, body: RegistryBody, last: Applied | undefined): void {
  const info = groupKey.info();
  const own = body.groups.find((g) => g.signingKey === info.signingKey);
  if (own === undefined || own.encryptionKey !== info.encryptionKey) throw rejected("group_key_mismatch");
  if (body.coordinatingGroup !== own.code) throw rejected("not_coordinating");
  if (body.groups.length !== 1) throw rejected("foreign_groups");
  if (own.state !== "active") throw rejected("own_state");
  if (own.relays.length === 0) throw rejected("no_relay");
  const previous = last?.body.groups[0];
  if (previous !== undefined && previous.code !== own.code) throw rejected("code_changed");
  const owners = new Map(boundKeys(db).map((k) => [k.publicKey, k.memberId]));
  const members = new Set<string>();
  for (const key of body.coordinatorKeys) {
    const member = owners.get(key);
    if (member === undefined || members.has(member)) throw rejected("coordinator_key_unbound");
    members.add(member);
  }
}

type Outcome =
  | { kind: "applied"; current: RegistryCurrent }
  | { kind: "same"; current: RegistryCurrent }
  | { kind: "conflict"; number: number }
  | { kind: "rejected"; error: ApiError; number: number | undefined; reason: string };

function reject(error: ApiError, number: number | undefined, reason: string): Outcome {
  return { kind: "rejected", error, number, reason };
}

/**
 * Кто передаёт версию: Член Группы сеанса Станции или — на API сопровождения — владелец подписавшего
 * Ключа Координатора (NET-54, APP-34); до проверки подписи автор такой версии — служба.
 */
export type ApplyActor = { memberId: string } | { bySignature: true } | { service: true };

/** Владелец Ключа Координатора на этой станции; не зарегистрирован — служба (NULL). */
function keyOwner(db: Db, publicKey: string): string | null {
  const row = db.prepare("SELECT memberId FROM coordinator_key WHERE publicKey = ? ORDER BY rowid DESC LIMIT 1").get(publicKey);
  return row === undefined ? null : String(row["memberId"]);
}

/**
 * POST /api/registry/versions (research R9, R10): одна транзакция BEGIN IMMEDIATE; отказ по
 * содержимому — запись журнала registry.reject отдельной транзакцией после отката.
 */
export function applyVersion(db: Db, groupKey: GroupKeyHandle, actor: ApplyActor | string, text: string): { status: 200 | 201; current: RegistryCurrent } {
  groupKey.assertAvailable();
  const by: ApplyActor = typeof actor === "string" ? { memberId: actor } : actor;
  let actorId: string | null = "memberId" in by ? by.memberId : null;
  const ownerOf = (key: string): string | null => ("bySignature" in by ? keyOwner(db, key) : actorId);
  const outcome = inTransaction(db, (): Outcome => {
    if ("memberId" in by) assertActor(db, by.memberId, "registry.apply");
    let doc: SignedDocument;
    let body: RegistryBody;
    try {
      doc = parseSignedDocument(text, REGISTRY_FORMAT);
      body = parseRegistryBody(doc.body);
    } catch (error) {
      const reason = error instanceof RegistryFormatError ? error.reason : error instanceof SignedDocumentError ? "format" : undefined;
      if (reason === undefined) throw error;
      return reject(rejected(reason), undefined, reason);
    }
    const number = body.number;
    if (doc.signatures.length === 0) return reject(rejected("unsigned"), number, "unsigned");
    const hash = bodySha256(doc.body);
    const last = lastApplied(db);
    const halted = isHalted(db);
    // Номер, подпись, развилка и NET-52 — общие правила со Ретранслятором (research R3 фичи 004).
    const check = checkSuccessor(
      {
        last,
        sameNumber: appliedNumber(db, number),
        before: appliedBefore(db, number),
        halted,
        firstSigner: (d, b) => firstVersionSigner(db, d, b),
      },
      doc,
      body,
      hash,
    );
    switch (check.kind) {
      case "same":
        return { kind: "same", current: currentView(last!) };
      case "conflict": {
        actorId = ownerOf(check.signer);
        db.prepare(
          "INSERT INTO registry_conflict (id, number, document, bodySha256, receivedAt, receivedBy) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(randomUUIDv7(), number, serializeSignedDocument(doc), hash, new Date().toISOString(), actorId);
        journal(db, actorId, "registry.conflict", number, { number, bodySha256: [appliedNumber(db, number)!.bodySha256, hash] });
        return { kind: "conflict", number };
      }
      case "stale":
        return reject(new ApiError("registry_stale", { number, known: last!.number }, { reason: "stale" }), number, "stale");
      case "not-first":
        return reject(rejected("format"), number, "format");
      case "halted":
        return reject(new ApiError("registry_halted", {}, { reason: "halted" }), number, "halted");
      case "signature":
        return reject(rejected("signature"), number, "signature");
    }
    const signer = check.signer;
    actorId = ownerOf(signer);
    try {
      checkContent(db, groupKey, body, last);
    } catch (error) {
      if (error instanceof ApiError) return reject(error, number, String(error.extra["reason"]));
      throw error;
    }

    const appliedAt = new Date().toISOString();
    db.prepare(
      "INSERT INTO registry_version (number, document, bodySha256, signedBy, appliedAt, appliedBy) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(number, serializeSignedDocument(doc), hash, signer, appliedAt, actorId);
    const details: Record<string, unknown> = { number, signedBy: keyFingerprint(signer) };
    if (halted) {
      // NET-52: следующая версия снимает остановку, развилки закрываются этим номером.
      const open = db.prepare("SELECT DISTINCT number FROM registry_conflict WHERE resolvedBy IS NULL ORDER BY number").all();
      db.prepare("UPDATE registry_conflict SET resolvedBy = ? WHERE resolvedBy IS NULL").run(number);
      details["resolved"] = open.map((r) => Number(r["number"]));
    }
    if ("service" in by) details["via"] = "relay";
    journal(db, actorId, "registry.apply", number, details);
    return { kind: "applied", current: currentView(lastApplied(db)!) };
  });

  switch (outcome.kind) {
    case "applied":
      networkEvents.emit("registry-applied", outcome.current.number);
      return { status: 201, current: outcome.current };
    case "same":
      return { status: 200, current: outcome.current };
    case "conflict":
      throw new ApiError("registry_conflict", { number: outcome.number });
    case "rejected":
      inTransaction(db, () => {
        const details: Record<string, unknown> = { reason: outcome.reason };
        if (outcome.number !== undefined) details["number"] = outcome.number;
        journal(db, actorId, "registry.reject", outcome.number, details);
      });
      throw outcome.error;
  }
}
