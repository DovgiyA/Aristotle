// Номер Кейса ГГГГ-NNN (research R3 фичи 005; BANK-26 … BANK-30): выдаёт Опорная станция в транзакции
// создания Кейса; год — год выдачи по UTC; счётчик по годам только растёт; выданный Номер — строка
// case_number, которая не удаляется: Номер Отклонённого Кейса не выдаётся снова. Продолжение с
// заданного Номера — для импорта (BANK-36, фича 017) и восстановления (BANK-57, фича 015).
import { message } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";

/** Номер вида ГГГГ-NNN: три цифры с ведущими нулями, после 999 — сколько нужно. */
export function formatCaseNumber(year: number, seq: number): string {
  return `${year}-${String(seq).padStart(3, "0")}`;
}

/** Взять следующий Номер года выдачи (счётчик +1). Вызывать внутри транзакции создания Кейса. */
export function reserveCaseNumber(db: Db, at: string): string {
  const year = Number(at.slice(0, 4));
  const row = db.prepare("SELECT last FROM case_number_counter WHERE year = ?").get(year);
  const seq = (row === undefined ? 0 : Number(row["last"])) + 1;
  // Счётчик, не знающий о занятых Номерах (перенос, восстановление), не выдаёт Номер не больше
  // занятого (BANK-30, Edge Cases spec.md фичи 005).
  const taken = maxTaken(db, year);
  // Отказ — типизированный 409 с годом и занятым Номером, а не 500 (T129).
  if (seq <= taken) throw new ApiError("case_counter_behind", { year, next: formatCaseNumber(year, seq), last: formatCaseNumber(year, taken) });
  if (row === undefined) db.prepare("INSERT INTO case_number_counter (year, last) VALUES (?, ?)").run(year, seq);
  else db.prepare("UPDATE case_number_counter SET last = ? WHERE year = ?").run(seq, year);
  return formatCaseNumber(year, seq);
}

/** Закрепить Номер за Кейсом: строка case_number не удаляется (BANK-30). */
export function bindCaseNumber(db: Db, number: string, caseId: string): void {
  const [year = "", seq = ""] = number.split("-");
  // Правка Кейса вызывает производное снова — Номер уже за ним; занятый другим — ошибка, не пропуск.
  const bound = db.prepare("SELECT caseId FROM case_number WHERE number = ?").get(number);
  if (bound !== undefined && String(bound["caseId"]) === caseId) return;
  db.prepare("INSERT INTO case_number (number, caseId, year, seq) VALUES (?, ?, ?, ?)").run(number, caseId, Number(year), Number(seq));
}

/** Выдать и закрепить Номер в одном вызове. */
export function issueCaseNumber(db: Db, at: string, caseId: string): string {
  const number = reserveCaseNumber(db, at);
  bindCaseNumber(db, number, caseId);
  return number;
}

/**
 * Продолжить счётчик года с Номера next: следующий выданный — next. Только вперёд: next не больше
 * уже выданного — отказ (BANK-30). Маршрута API нет — вызывают импорт и восстановление.
 */
export function advanceCaseCounter(db: Db, year: number, next: number): void {
  const row = db.prepare("SELECT last FROM case_number_counter WHERE year = ?").get(year);
  const last = Math.max(row === undefined ? 0 : Number(row["last"]), maxTaken(db, year));
  if (!Number.isInteger(next) || next <= last) throw new Error(message("case_counter_backwards", { year, next, last }));
  if (row === undefined) db.prepare("INSERT INTO case_number_counter (year, last) VALUES (?, ?)").run(year, next - 1);
  else db.prepare("UPDATE case_number_counter SET last = ? WHERE year = ?").run(next - 1, year);
}

/** Наибольший занятый Номер года в case_number (0 — нет ни одного). */
function maxTaken(db: Db, year: number): number {
  return Number(db.prepare("SELECT coalesce(max(seq), 0) AS m FROM case_number WHERE year = ?").get(year)?.["m"]);
}
