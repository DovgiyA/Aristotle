// Заведение первого Старшего Группы при установке (ROLE-26, FR-003, INBOX-30, BANK-05).
import { randomUUIDv7 } from "node:crypto";
import type { BootstrapRequest, Member } from "@aristotel/protocol";
import { inTransaction, type Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";

/**
 * Одной транзакцией завести первого Старшего и запись журнала member.bootstrap.
 * Автор записи журнала — сам заведённый Старший; второй вызов — already_bootstrapped.
 */
export function bootstrapFirstSenior(db: Db, request: BootstrapRequest): Member {
  return inTransaction(db, () => {
    const existing = db.prepare("SELECT count(*) AS n FROM member").get();
    if (Number(existing?.["n"]) > 0) throw new ApiError("already_bootstrapped");
    const member: Member = {
      id: randomUUIDv7(),
      label: request.label,
      role: "senior",
      state: "active",
      version: 1,
      createdAt: new Date().toISOString(),
    };
    db.prepare(
      "INSERT INTO member (id, label, role, state, createdAt, bootstrap) VALUES (?, ?, ?, ?, ?, 1)",
    ).run(member.id, member.label, member.role, member.state, member.createdAt);
    db.prepare(
      "INSERT INTO journal (at, actorId, action, subjectType, subjectId, details) VALUES (?, ?, 'member.bootstrap', 'member', ?, ?)",
    ).run(member.createdAt, member.id, member.id, JSON.stringify({ via: "cli-init", osAccount: request.osAccount }));
    return member;
  });
}
