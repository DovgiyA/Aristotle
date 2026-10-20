// Сводка Кейса для GET /api/cases/:id: отвеченность обязательных полей (DATA-27) и недостающие разделы
// Отчёта (DATA-31). Общая часть — здесь, поля Формуляра Изделий и скелет Отчёта добавляет фича
// (US4: model/form.ts, protocol/report-skeleton.ts) через registerCaseSummary.
import type { BankRecord } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import type { Reader } from "../bank/visibility.ts";
import { generalPartAnswered } from "./field-value.ts";

type Summary = {
  answered?: (db: Db, record: BankRecord, items: BankRecord[], reader?: Reader) => string[];
  missingSections?: (db: Db, record: BankRecord, items: BankRecord[]) => string[];
};
const extensions: Summary[] = [];

export function registerCaseSummary(summary: Summary): void {
  if (!extensions.includes(summary)) extensions.push(summary);
}

/** Отвеченность — по Записям, видимым читающему: Секрет-Записи Наблюдателю следа не оставляют (VIEW-16; T203). */
export function caseAnswered(db: Db, record: BankRecord, items: BankRecord[], reader?: Reader): { complete: boolean; missing: string[] } {
  const missing = [...generalPartAnswered(record.fields).missing, ...extensions.flatMap((e) => e.answered?.(db, record, items, reader) ?? [])];
  return { complete: missing.length === 0, missing };
}

export function caseMissingSections(db: Db, record: BankRecord, items: BankRecord[]): string[] {
  return extensions.flatMap((e) => e.missingSections?.(db, record, items) ?? []);
}
