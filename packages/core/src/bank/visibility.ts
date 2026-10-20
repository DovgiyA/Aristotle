// Видимость Секрета: у Наблюдателя Секрет-Записей нет без следа — ни Записи, ни истории, ни записей
// журнала о ней; решает текущая метка (ROLE-07, ROLE-23, VIEW-16, VIEW-58; research R3).
// Перечень и поиск Записей (фича 011) обязаны брать это же правило, а не своё.
import type { Role } from "@aristotel/protocol";

/** Читающий — Член Группы, от имени которого идёт чтение; без него — внутреннее чтение ядра. */
export interface Reader {
  role: Role;
}

/**
 * Получает ли читающий сквозные номера журнала и истории: Наблюдателю — нет, их пропуски выдают
 * Секрет-Записи (VIEW-59).
 */
export function seesSequenceNumbers(reader: Reader | undefined): boolean {
  return reader === undefined || reader.role !== "observer";
}

/** Видит ли читающий Запись с такой меткой Секрет. */
export function canSeeRecord(reader: Reader | undefined, secret: boolean): boolean {
  return reader === undefined || reader.role !== "observer" || !secret;
}

/**
 * Условие SQL на журнал под псевдонимом j: для Наблюдателя — без записей о Секрет-Записях, для
 * остальных — пусто. Подзапрос идёт по первичному ключу record.id (research R3).
 */
export function journalVisibilitySql(reader: Reader | undefined): string {
  if (reader === undefined || reader.role !== "observer") return "";
  return "NOT (j.subjectType = 'record' AND EXISTS (SELECT 1 FROM record r WHERE r.id = j.subjectId AND r.secret = 1))";
}
