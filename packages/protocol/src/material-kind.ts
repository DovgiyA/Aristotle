// Правила вида Материала (BANK-59 … BANK-63; research R8 фичи 006): одна чистая функция для ядра, CLI
// и интерфейса — какое действие таблицы прав нужно для смены вида и можно ли её сделать вообще.
// Первичная постановка вида Материалу без вида — не смена (Clarifications 2026-10-20). Перевести
// образ или логическую копию в другой вид, кроме этих двух, может только Старший с подтверждением
// присутствия (BANK-62, STATION-12). «Прежний файл» ставит только Конвертер, «Внешний источник» бывает
// только у Материала Документа (BANK-61).
import { MATERIAL_KINDS } from "./slovar.ts";

export type MaterialKind = (typeof MATERIAL_KINDS)[number];
export type MaterialOwnerType = "case" | "document";

export function isMaterialKind(value: unknown): value is MaterialKind {
  return typeof value === "string" && (MATERIAL_KINDS as readonly string[]).includes(value);
}

/** Виды, которые остаются у Владеющей Группы: выпустить их в другой вид — решение Старшего (AGR-35). */
const HELD_KINDS: readonly string[] = ["image", "logical_copy"];

export type KindChange =
  | { action: "material.kind.set" }
  | { action: "material.kind.release"; warning: "material_starts_leaving" }
  | { error: "material_kind_unknown" | "material_kind_converter_only" | "material_kind_owner" };

/**
 * Что нужно, чтобы поставить вид to Материалу вида from (null — вида нет). appliedKinds — Коды перечня
 * material_kind применённого Словаря Сети: вид из более новой версии, которого программа не знает, и
 * вид, которого нет в применённой версии, не ставятся (BANK-63, DICT-60). Конвертер (фича 017) ставит
 * «Прежний файл» внутренним вызовом мимо этой функции.
 */
export function kindChangeAction(from: string | null, to: string, ownerType: MaterialOwnerType, appliedKinds?: readonly string[]): KindChange {
  if (!isMaterialKind(to) || (appliedKinds !== undefined && !appliedKinds.includes(to))) return { error: "material_kind_unknown" };
  if (to === "legacy_file" || from === "legacy_file") return { error: "material_kind_converter_only" };
  if (to === "external_source" && ownerType !== "document") return { error: "material_kind_owner" };
  if (from !== null && HELD_KINDS.includes(from) && !HELD_KINDS.includes(to)) return { action: "material.kind.release", warning: "material_starts_leaving" };
  return { action: "material.kind.set" };
}
