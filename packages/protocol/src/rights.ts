// Таблица прав — одна на ядро и интерфейс: вид действия → роли и признак подтверждения присутствия
// (FR-005 фичи 002; ROLE-10 … ROLE-22, ROLE-36, ROLE-37; STATION-12; data-model.md «Права» фичи 004;
// research R10, R15 фичи 004). Ядро проверяет по ней права, интерфейс прячет недоступные действия и
// заранее знает, где спросить пароль. Следующие фичи добавляют сюда строки своих действий.
import type { Role } from "./members.ts";

export const ACTIONS = [
  "record.read",
  "record.create",
  "record.update",
  "record.secret.mark",
  "record.secret.unmark",
  "journal.read",
  "member.read",
  "member.create",
  "member.update",
  "member.revoke",
  // Фича 003: Реестр Сети и Ключи Координатора (ROLE-37, NET-13; research R12 фичи 003).
  "registry.read",
  "registry.draft",
  "registry.apply",
  "coordinator-key.register",
  "coordinator-key.withdraw",
  // Фича 004: Станции, Приглашения, параметры Группы (VIEW-47, STATION-13, STATION-17, STATION-44).
  "station.read",
  "station.revoke",
  "invitation.read",
  "invitation.issue",
  "invitation.cancel",
  "group-setting.update",
  // Фича 005: Словарь Сети и Местное расширение (DICT-05, DICT-16, VIEW-50; data-model.md «Права» фичи 005).
  "dictionary.read",
  "dictionary.apply",
  "local-extension.propose",
  "local-extension.decide",
  // Фича 006: Материалы и Заверение (BANK-12, BANK-17, BANK-19, BANK-62, STATION-21; data-model.md «Права» фичи 006).
  "material.register",
  "material.deliver",
  "material.kind.set",
  "material.kind.release",
  "material.delete",
  "material.station-list",
] as const;

export type Action = (typeof ACTIONS)[number];

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

export interface RightRow {
  roles: readonly Role[];
  /** Нужно подтверждение присутствия — повторный ввод пароля на Станции (STATION-12). */
  presence: boolean;
}

const ALL: readonly Role[] = ["participant", "senior", "observer"];
const WRITERS: readonly Role[] = ["participant", "senior"];
const SENIOR: readonly Role[] = ["senior"];

export const RIGHTS: Readonly<Record<Action, RightRow>> = {
  // Наблюдатель читает без Секретов — фильтр видимости в ядре (VIEW-16, VIEW-58).
  "record.read": { roles: ALL, presence: false },
  "record.create": { roles: WRITERS, presence: false },
  "record.update": { roles: WRITERS, presence: false },
  "record.secret.mark": { roles: WRITERS, presence: false },
  "record.secret.unmark": { roles: SENIOR, presence: true },
  "journal.read": { roles: ALL, presence: false },
  "member.read": { roles: ALL, presence: false },
  "member.create": { roles: SENIOR, presence: true },
  "member.update": { roles: SENIOR, presence: true },
  "member.revoke": { roles: SENIOR, presence: true },
  "registry.read": { roles: ALL, presence: false },
  "registry.draft": { roles: SENIOR, presence: false },
  // Подпись Ключом Координатора (STATION-12); через CLI без службы — NET-54, проверяет только API Станций.
  "registry.apply": { roles: SENIOR, presence: true },
  "coordinator-key.register": { roles: SENIOR, presence: true },
  "coordinator-key.withdraw": { roles: SENIOR, presence: false },
  "station.read": { roles: SENIOR, presence: false },
  // Отзыв Станции — без подтверждения присутствия (STATION-12).
  "station.revoke": { roles: SENIOR, presence: false },
  "invitation.read": { roles: SENIOR, presence: false },
  "invitation.issue": { roles: SENIOR, presence: true },
  "invitation.cancel": { roles: SENIOR, presence: false },
  "group-setting.update": { roles: SENIOR, presence: false },
  "dictionary.read": { roles: ALL, presence: false },
  // Подпись Ключом Координатора (STATION-12); через CLI без службы — NET-54, проверяет только API Станций.
  "dictionary.apply": { roles: SENIOR, presence: true },
  "local-extension.propose": { roles: WRITERS, presence: false },
  "local-extension.decide": { roles: SENIOR, presence: false },
  // Чтение Записи о Материале и её файла — record.read; Наблюдатель — без Секретов и только через программу (BANK-15).
  "material.register": { roles: WRITERS, presence: false },
  // Кроме роли — Станция Члена Группы, зарегистрировавшего Материал, или Станция Старшего (FR-008a).
  "material.deliver": { roles: WRITERS, presence: false },
  "material.kind.set": { roles: WRITERS, presence: false },
  // Перевод образа или логической копии в другой вид (BANK-62, STATION-12).
  "material.kind.release": { roles: SENIOR, presence: true },
  // Удаления Материала нет в закрытом перечне STATION-12 — без подтверждения присутствия.
  "material.delete": { roles: SENIOR, presence: false },
  "material.station-list": { roles: SENIOR, presence: false },
};

export function rolesOf(action: Action): readonly Role[] {
  return RIGHTS[action].roles;
}

export function needsPresence(action: Action): boolean {
  return RIGHTS[action].presence;
}

export function isAllowed(role: Role, action: Action): boolean {
  return RIGHTS[action].roles.includes(role);
}
