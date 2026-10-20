// Приглашения и приём Станции на Опорной станции: выпуск Старшим (не себе) и через CLI на самой
// Опорной станции по STATION-43, отмена, приём по одноразовому секрету — в одной транзакции
// (STATION-13, STATION-14, STATION-16, STATION-43, STATION-44; contracts/stanciya-v1.md; research R7
// фичи 004). Секрета Приглашения в БД нет: только открытый ключ Прохода и хэш ключа приёма.
import { randomBytes, randomUUIDv7 } from "node:crypto";
import {
  acceptKeyHash,
  decodeBytes,
  decodeKey,
  deriveInvitationKeys,
  encodeBytes,
  encodeInvitation,
  keyFingerprint,
  type AcceptRequest,
  type AcceptResponse,
  type InvitationView,
  type IssueInvitationResponse,
  type Role,
} from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { assertActor } from "../rights/rights.ts";
import { registryState } from "../network/registry.ts";
import type { GroupKeyHandle } from "../network/group-key.ts";
import { broadcastPassageList } from "../passage/passage-list.ts";

export interface InvitationContext {
  db: Db;
  installId: string;
  groupKey: GroupKeyHandle;
  /** Отпечаток TLS Опорной станции — закрепляется на Станции при приёме (STATION-03). */
  tlsSpki: () => string;
}

/** Своя запись в последней применённой версии: Код и адреса Проходов (STATION-42). */
export function ownPassages(ctx: InvitationContext): { code: string; passages: string[] } | undefined {
  const current = registryState(ctx.db).current;
  const signingKey = ctx.groupKey.info().signingKey;
  const own = current?.body.groups.find((g) => g.signingKey === signingKey && g.state === "active");
  if (own === undefined || own.relays.length === 0) return undefined;
  return { code: own.code, passages: own.relays.map((r) => r.url) };
}

function setting(db: Db, key: "invitationHours" | "deleteOnlyDays"): number {
  return Number(db.prepare("SELECT value FROM group_setting WHERE key = ?").get(key)?.["value"]);
}

function journal(db: Db, actorId: string | null, action: string, subjectType: string, subjectId: string, details: Record<string, unknown>): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, ?, ?, ?)").run(
    new Date().toISOString(),
    actorId,
    action,
    subjectType,
    subjectId,
    JSON.stringify(details),
  );
}

function assertTargetActive(db: Db, memberId: string): { role: Role } {
  const member = db.prepare("SELECT role, state FROM member WHERE id = ?").get(memberId);
  if (member === undefined) throw new ApiError("not_found", { id: memberId }, {}, "member_not_found");
  if (member["state"] !== "active") throw new ApiError("member_not_active", { id: memberId }, {}, "invitation_member_not_active");
  return { role: String(member["role"]) as Role };
}

function issue(ctx: InvitationContext, memberId: string, issuedBy: string | null, now: Date): IssueInvitationResponse {
  const own = ownPassages(ctx);
  if (own === undefined) throw new ApiError("network_not_launched");
  const secret = new Uint8Array(randomBytes(32));
  const keys = deriveInvitationKeys(secret);
  const id = randomUUIDv7();
  const expiresAt = new Date(now.getTime() + setting(ctx.db, "invitationHours") * 3600_000).toISOString();
  ctx.db
    .prepare(
      "INSERT INTO invitation (id, memberId, issuedBy, issuedAt, expiresAt, passageKey, acceptKeyHash, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued')",
    )
    .run(id, memberId, issuedBy, now.toISOString(), expiresAt, keys.passageKey, acceptKeyHash(keys.acceptKey));
  const details: Record<string, unknown> = { memberId, expiresAt };
  if (issuedBy === null) details["via"] = "cli";
  journal(ctx.db, issuedBy, "invitation.issue", "invitation", id, details);
  const invitation = encodeInvitation({
    code: own.code,
    invitationId: id,
    passages: own.passages,
    baseTlsSpki: ctx.tlsSpki(),
    secret: encodeBytes(secret),
    expiresAt,
  });
  return { id, memberId, expiresAt, invitation };
}

/** POST /api/invitations — Старший со Станции, не себе (STATION-13, STATION-14). */
export function issueInvitation(ctx: InvitationContext, actorId: string, memberId: string, now: Date = new Date()): IssueInvitationResponse {
  const result = inTransaction(ctx.db, () => {
    assertActor(ctx.db, actorId, "invitation.issue");
    if (memberId === actorId) throw new ApiError("invitation_self");
    assertTargetActive(ctx.db, memberId);
    return issue(ctx, memberId, actorId, now);
  });
  broadcastPassageList();
  return result;
}

/**
 * POST /api/invitations/senior на API сопровождения (STATION-43): Старшему, если ни у одного другого
 * действующего Старшего нет действующей Станции; первое Приглашение (ROLE-26) — этот же случай.
 */
export function issueSeniorInvitation(ctx: InvitationContext, memberId: string, now: Date = new Date()): IssueInvitationResponse {
  const result = inTransaction(ctx.db, () => {
    const target = assertTargetActive(ctx.db, memberId);
    if (target.role !== "senior") throw new ApiError("forbidden", {}, {}, "invitation_not_senior");
    const other = ctx.db
      .prepare(
        `SELECT 1 AS x FROM station s JOIN member m ON m.id = s.memberId
         WHERE s.state = 'active' AND m.role = 'senior' AND m.state = 'active' AND m.id <> ? LIMIT 1`,
      )
      .get(memberId);
    if (other !== undefined) throw new ApiError("invitation_senior_has_station");
    return issue(ctx, memberId, null, now);
  });
  broadcastPassageList();
  return result;
}

/** POST /api/invitations/:id/cancel — любой Старший, без подтверждения присутствия (STATION-44). */
export function cancelInvitation(db: Db, actorId: string, id: string, now: Date = new Date()): InvitationView {
  inTransaction(db, () => {
    assertActor(db, actorId, "invitation.cancel");
    const row = db.prepare("SELECT state, expiresAt FROM invitation WHERE id = ?").get(id);
    if (row === undefined) throw new ApiError("not_found", { id }, {}, "invitation_not_found");
    if (row["state"] !== "issued" || String(row["expiresAt"]) <= now.toISOString()) throw new ApiError("invitation_not_issued");
    db.prepare("UPDATE invitation SET state = 'cancelled', cancelledAt = ?, cancelledBy = ? WHERE id = ?").run(now.toISOString(), actorId, id);
    journal(db, actorId, "invitation.cancel", "invitation", id, {});
  });
  broadcastPassageList();
  return listInvitations(db, now).find((i) => i.id === id)!;
}

/** GET /api/invitations — без строк и секретов (contracts/http-api.md). */
export function listInvitations(db: Db, now: Date = new Date()): InvitationView[] {
  return db
    .prepare(
      `SELECT i.*, m.label AS memberLabel, b.label AS issuedByLabel FROM invitation i
       JOIN member m ON m.id = i.memberId LEFT JOIN member b ON b.id = i.issuedBy
       ORDER BY i.rowid`,
    )
    .all()
    .map((r) => {
      const state = String(r["state"]);
      const expired = state === "issued" && String(r["expiresAt"]) <= now.toISOString();
      return {
        id: String(r["id"]),
        memberId: String(r["memberId"]),
        memberLabel: String(r["memberLabel"]),
        issuedBy: r["issuedBy"] === null ? null : { id: String(r["issuedBy"]), label: String(r["issuedByLabel"]) },
        issuedAt: String(r["issuedAt"]),
        expiresAt: String(r["expiresAt"]),
        view: expired ? "expired" : (state as InvitationView["view"]),
      };
    });
}

/**
 * POST /api/stations/accept (STATION-16): одна транзакция — срок по часам Опорной станции, состояние
 * issued, хэш ключа приёма, Член Группы действует; любая из этих причин — один ответ invitation_invalid.
 */
export function acceptStation(ctx: InvitationContext, request: AcceptRequest, now: Date = new Date()): AcceptResponse {
  const acceptKey = decodeBytes(request.acceptKey, 32);
  if (acceptKey === undefined || decodeKey(request.stationKey) === undefined) throw new ApiError("invitation_invalid");
  const result = inTransaction(ctx.db, () => {
    const row = ctx.db.prepare("SELECT * FROM invitation WHERE id = ?").get(request.invitationId);
    const member = row === undefined ? undefined : ctx.db.prepare("SELECT label, role, state FROM member WHERE id = ?").get(String(row["memberId"]));
    if (
      row === undefined ||
      member === undefined ||
      row["state"] !== "issued" ||
      String(row["expiresAt"]) <= now.toISOString() ||
      row["acceptKeyHash"] !== acceptKeyHash(acceptKey) ||
      member["state"] !== "active"
    ) {
      throw new ApiError("invitation_invalid");
    }
    if (ctx.db.prepare("SELECT 1 AS x FROM station WHERE publicKey = ?").get(request.stationKey) !== undefined) throw new ApiError("station_key_taken");
    const memberId = String(row["memberId"]);
    const stationId = randomUUIDv7();
    const fingerprint = keyFingerprint(request.stationKey);
    ctx.db
      .prepare("INSERT INTO station (id, memberId, publicKey, keyFingerprint, invitationId, acceptedAt, state) VALUES (?, ?, ?, ?, ?, ?, 'active')")
      .run(stationId, memberId, request.stationKey, fingerprint, request.invitationId, now.toISOString());
    ctx.db.prepare("UPDATE invitation SET state = 'used', usedAt = ? WHERE id = ?").run(now.toISOString(), request.invitationId);
    journal(ctx.db, memberId, "station.accept", "station", stationId, { invitationId: request.invitationId, keyFingerprint: fingerprint });
    const own = ownPassages(ctx);
    return {
      stationId,
      installId: ctx.installId,
      memberId,
      memberLabel: String(member["label"]),
      role: String(member["role"]) as Role,
      code: own?.code ?? "",
      passages: own?.passages ?? [],
    };
  });
  broadcastPassageList();
  return result;
}
