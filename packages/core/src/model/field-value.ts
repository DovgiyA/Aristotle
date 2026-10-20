// Значение поля (research R11 фичи 005; DATA-25 … DATA-30): каноническое значение или одно из трёх
// состояний пустого поля; «отвечено» — значение или состояние (DATA-27).

import { trimSpace } from "@aristotel/protocol";

/**
 * Пустая ли строка — по пробелам Юникода (White_Space), как у проверки формата и нормализации: одно
 * правило во всей модели (DATA-26; T269).
 */
export function isBlank(v: string): boolean {
  return trimSpace(v) === "";
}

export type EmptyState = "not_established" | "absent" | "not_applicable";

/** Отвечено ли поле: непустое значение или состояние пустого поля (DATA-26, DATA-27). */
export function answered(v: unknown): boolean {
  if (typeof v === "string") return !isBlank(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object" && v !== null) {
    const state = (v as { state?: unknown }).state;
    if (state === "not_established") return typeof (v as { reason?: unknown }).reason === "string" && !isBlank(String((v as { reason: string }).reason));
    return state === "absent" || state === "not_applicable";
  }
  return false;
}

/** Обязательные поля общей части Кейса (DATA-14, DATA-15, DATA-17, DATA-19). */
export const GENERAL_PART_REQUIRED = ["seizedAt", "receivedAt", "shape", "performers"] as const;

export function generalPartAnswered(fields: Record<string, unknown>): { complete: boolean; missing: string[] } {
  const missing = GENERAL_PART_REQUIRED.filter((f) => !answered(fields[f]));
  return { complete: missing.length === 0, missing };
}

/**
 * Значение hw_kind — «носитель» (storage): как его видит проверка формата — без пробелов по краям
 * (DATA-13, DICT-37; T208). Хранится как введено.
 */
export function isStorageValue(value: unknown): boolean {
  return typeof value === "string" && trimSpace(value) === "storage";
}
