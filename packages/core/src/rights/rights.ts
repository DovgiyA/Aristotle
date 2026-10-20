// Одно правило прав: таблица «вид действия → роли» живёт в protocol (общая с интерфейсом, research
// R15 фичи 004), здесь — проверки (FR-005, ROLE-05; research R1 фичи 002). Следующие фичи добавляют
// строки в таблицу, а не свои проверки роли в маршрутах.
import { isAllowed, type Action, type Role } from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";
import type { Db } from "../db/open.ts";
import { assertSessionOpen } from "../stations/sessions.ts";

export { isAllowed };

/** Отказ 403 forbidden, если роли действие не разрешено. */
export function assertAllowed(role: Role, action: Action): void {
  if (!isAllowed(role, action)) throw new ApiError("forbidden");
}

/**
 * Автор — действующий Член Группы, и его роли действие разрешено; вернуть роль. Состояние и роль
 * читаются из БД: хук API зовёт это на каждом запросе, а изменяющие функции ядра — ещё раз первым
 * шагом своей транзакции, потому что между хуком и транзакцией автора могут отозвать или снять с
 * роли (FR-004, STATION-17; research R1, R6 фичи 002). Запрос из API Станций — ещё и его сеанс: Станцию
 * могут отозвать (research R11 фичи 004).
 */
export function assertActor(db: Db, actorId: string, action: Action): Role {
  assertSessionOpen(db);
  const member = db.prepare("SELECT role, state FROM member WHERE id = ?").get(actorId);
  if (member === undefined) throw new ApiError("unknown_member", { member: actorId });
  if (member["state"] !== "active") throw new ApiError("member_revoked", { member: actorId });
  const role = String(member["role"]) as Role;
  assertAllowed(role, action);
  return role;
}
