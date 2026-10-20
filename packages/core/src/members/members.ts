// Состав Группы: чтение, заведение, смена роли и подписи, отзыв — каждое изменение одной
// транзакцией вместе с записью журнала (ROLE-03, ROLE-04, ROLE-08, ROLE-21, ROLE-27, ROLE-35,
// ROLE-36, STATION-17, STATION-18, INBOX-30, BANK-05; research R4, R6 … R8).
import { randomUUIDv7 } from "node:crypto";
import type { CreateMemberRequest, Member, RevokeMemberRequest, Role, UpdateMemberRequest } from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { assertActor } from "../rights/rights.ts";
import { afterStationsRevoked, revokeMemberStationsInTx } from "../stations/stations.ts";
import { message } from "@aristotel/protocol";

function rowToMember(row: Record<string, unknown>): Member {
  return {
    id: String(row["id"]),
    label: String(row["label"]),
    role: String(row["role"]) as Member["role"],
    state: String(row["state"]) as Member["state"],
    version: Number(row["version"]),
    createdAt: String(row["createdAt"]),
  };
}

/** Состав Группы в порядке заведения — по порядку вставки, а не по часам машины; в том числе отозванные (ROLE-36). */
export function listMembers(db: Db): Member[] {
  return db.prepare("SELECT * FROM member ORDER BY rowid").all().map(rowToMember);
}

export function getMember(db: Db, id: string): Member | undefined {
  const row = db.prepare("SELECT * FROM member WHERE id = ?").get(id);
  return row === undefined ? undefined : rowToMember(row);
}

function notFound(id: string): ApiError {
  return new ApiError("not_found", { id }, {}, "member_not_found");
}

function activeSeniors(db: Db): number {
  return Number(db.prepare("SELECT count(*) AS n FROM member WHERE role = 'senior' AND state = 'active'").get()?.["n"]);
}

function writeJournal(db: Db, action: string, actorId: string, memberId: string, at: string, details: unknown): void {
  db.prepare(
    "INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, ?, 'member', ?, ?)",
  ).run(at, actorId, action, memberId, details === null ? null : JSON.stringify(details));
}

/**
 * Число действующих Старших после изменения: больше двух — senior_limit (ROLE-04), ноль —
 * last_senior (ROLE-35). Считается внутри BEGIN IMMEDIATE, поэтому одновременные действия идут
 * друг за другом и второе видит итог первого (research R4); триггеры БД — последний рубеж.
 */
function checkSeniorBounds(db: Db, before: { role: Role; active: boolean }, after: { role: Role; active: boolean }): void {
  const wasSenior = before.active && before.role === "senior";
  const isSenior = after.active && after.role === "senior";
  if (wasSenior === isSenior) return;
  const seniors = activeSeniors(db) + (isSenior ? 1 : -1);
  if (seniors > 2) throw new ApiError("senior_limit");
  if (seniors < 1) throw new ApiError("last_senior");
}

/** Текущая запись Члена Группы для изменения: есть, действует, версия совпадает (research R6, R7). */
function current(db: Db, id: string, expectedVersion: number): Member {
  const member = getMember(db, id);
  if (member === undefined) throw notFound(id);
  if (member.state !== "active") throw new ApiError("member_not_active", { id });
  if (member.version !== expectedVersion) {
    throw new ApiError("version_conflict", {}, { current: member }, "member_version_conflict");
  }
  return member;
}

export function createMember(db: Db, request: CreateMemberRequest, actorId: string): Member {
  return inTransaction(db, () => {
    assertActor(db, actorId, "member.create");
    checkSeniorBounds(db, { role: "participant", active: false }, { role: request.role, active: true });
    const member: Member = {
      id: randomUUIDv7(),
      label: request.label,
      role: request.role,
      state: "active",
      version: 1,
      createdAt: new Date().toISOString(),
    };
    db.prepare("INSERT INTO member (id, label, role, state, version, createdAt) VALUES (?, ?, ?, 'active', 1, ?)").run(
      member.id,
      member.label,
      member.role,
      member.createdAt,
    );
    writeJournal(db, "member.create", actorId, member.id, member.createdAt, { role: member.role });
    return member;
  });
}

/** Сменить роль и/или подпись; без изменений — прежняя запись без журнала. */
export function updateMember(db: Db, id: string, request: UpdateMemberRequest, actorId: string): Member {
  // Неизвестные поля тела отбрасываются схемой — изменение без role и label не принимается.
  if (request.role === undefined && request.label === undefined) {
    throw new ApiError("invalid_request", { detail: message("detail_member_update_empty") });
  }
  return inTransaction(db, () => {
    assertActor(db, actorId, "member.update");
    const member = current(db, id, request.expectedVersion);
    const details: Record<string, { before: string; after: string }> = {};
    if (request.role !== undefined && request.role !== member.role) details["role"] = { before: member.role, after: request.role };
    if (request.label !== undefined && request.label !== member.label) details["label"] = { before: member.label, after: request.label };
    if (Object.keys(details).length === 0) return member;
    const role = request.role ?? member.role;
    checkSeniorBounds(db, { role: member.role, active: true }, { role, active: true });
    const label = request.label ?? member.label;
    db.prepare("UPDATE member SET role = ?, label = ?, version = version + 1 WHERE id = ? AND version = ?").run(
      role,
      label,
      id,
      member.version,
    );
    writeJournal(db, "member.update", actorId, id, new Date().toISOString(), details);
    return { ...member, role, label, version: member.version + 1 };
  });
}

/** Отозвать Члена Группы: конечное состояние; авторство в истории и журнале не меняется (STATION-18). */
export function revokeMember(db: Db, id: string, request: RevokeMemberRequest, actorId: string): Member {
  let stations: string[] = [];
  const revoked = inTransaction(db, () => {
    assertActor(db, actorId, "member.revoke");
    const member = current(db, id, request.expectedVersion);
    checkSeniorBounds(db, { role: member.role, active: true }, { role: member.role, active: false });
    db.prepare("UPDATE member SET state = 'revoked', version = version + 1 WHERE id = ? AND version = ?").run(id, member.version);
    writeJournal(db, "member.revoke", actorId, id, new Date().toISOString(), null);
    // Станции отозванного — в той же транзакции (STATION-18, фича 004).
    stations = revokeMemberStationsInTx(db, id, actorId);
    return { ...member, state: "revoked" as const, version: member.version + 1 };
  });
  afterStationsRevoked(stations);
  return revoked;
}
