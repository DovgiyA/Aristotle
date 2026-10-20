// Производное Индикатора — indicator_value (research R1, R8, R9 фичи 005; DICT-14, DICT-37 … DICT-40,
// DICT-57, DATA-29): канонический тип, нормализованная форма по Классу, метки, пометка Стоп-листа,
// «опознаёт ли». Значение хранится как введено; производное пересчитывается из него.
import { domainToASCII } from "node:url";
import { checkFormat, message, normalize, parseFormat, type FormatContext, trimSpace } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import type { AppliedDictionary } from "../dictionary/current.ts";

export type Mark = "out_of_dictionary" | "not_normalizable" | "format_violation" | "unverified";

export interface IndicatorValue {
  canonicalTypeId: string;
  normClass: string | null;
  normalized: string | null;
  flags: Mark[];
  stopListEntryId: string | null;
  identifying: boolean;
}

export function formatContext(dict: AppliedDictionary): FormatContext {
  return {
    toAscii: domainToASCII,
    enumCodes: (code) => {
      const en = dict.byCode("enum", code);
      if (en === undefined) return undefined;
      const aliases = Object.keys((en.props["aliases"] as Record<string, string> | undefined) ?? {});
      return new Set([...dict.enumValues(en.id).map((v) => v.code), ...aliases]);
    },
    closedEnum: (code) => dict.byCode("enum", code)?.props["closed"] === true,
  };
}

const MARK_ORDER: Mark[] = ["format_violation", "out_of_dictionary", "not_normalizable", "unverified"];

/** Производное по полям Индикатора и применённому Словарю. */
export function computeIndicatorValue(dict: AppliedDictionary, fields: Record<string, unknown>): IndicatorValue {
  const canonicalTypeId = dict.canonicalId(String(fields["type"]));
  const type = dict.indicatorType(canonicalTypeId);
  const flags = new Set<Mark>();
  let normalized: string | null = null;
  let stopListEntryId: string | null = null;
  const value = typeof fields["value"] === "string" ? fields["value"] : undefined;
  // Пробелы — по правилу формата и модели (trimSpace, T269; T280).
  if (type !== undefined && value !== undefined && trimSpace(value) !== "") {
    try {
      const result = checkFormat(parseFormat(type.format), value, formatContext(dict));
      if (result === "format_violation") flags.add("format_violation");
      if (result === "out_of_dictionary") flags.add("out_of_dictionary");
    } catch {
      flags.add("format_violation");
    }
    if (type.normClass !== null) {
      const n = normalize(type.normClass, value, { toAscii: domainToASCII });
      if (n.ok) normalized = n.value;
      else flags.add("not_normalizable");
    }
    stopListEntryId = dict.stopMatcher.match(canonicalTypeId, normalized ?? trimSpace(value))?.id ?? null;
  }
  const source = fields["source"] as { kind?: string } | undefined;
  // «Авто» и «агент» — «не проверено» до Проверки (DATA-29, AGENT-08; T222).
  if ((source?.kind === "auto" || source?.kind === "agent") && fields["verified"] !== true) flags.add("unverified");
  const level = dict.element(canonicalTypeId)?.level;
  const identifying = type !== undefined && type.identifying !== "none" && level === "network" && normalized !== null && stopListEntryId === null;
  return { canonicalTypeId, normClass: type?.normClass ?? null, normalized, flags: MARK_ORDER.filter((m) => flags.has(m)), stopListEntryId, identifying };
}

export function writeIndicatorValue(db: Db, recordId: string, v: IndicatorValue): void {
  db.prepare(
    "INSERT OR REPLACE INTO indicator_value (recordId, canonicalTypeId, normClass, normalized, flags, stopListEntryId, identifying) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(recordId, v.canonicalTypeId, v.normClass, v.normalized, JSON.stringify(v.flags), v.stopListEntryId, v.identifying ? 1 : 0);
}

export function readIndicatorValue(db: Db, recordId: string): IndicatorValue | undefined {
  const r = db.prepare("SELECT * FROM indicator_value WHERE recordId = ?").get(recordId);
  if (r === undefined) return undefined;
  return {
    canonicalTypeId: String(r["canonicalTypeId"]),
    normClass: r["normClass"] === null ? null : String(r["normClass"]),
    normalized: r["normalized"] === null ? null : String(r["normalized"]),
    flags: JSON.parse(String(r["flags"])) as Mark[],
    stopListEntryId: r["stopListEntryId"] === null ? null : String(r["stopListEntryId"]),
    identifying: Number(r["identifying"]) === 1,
  };
}

/** Пометка Стоп-листа для ответа API: список, пояснение, единый текст DICT-43. */
export function stopListMark(dict: AppliedDictionary, entryId: string | null): { list: string; listLabel: string; note: string; text: string } | null {
  if (entryId === null) return null;
  const entry = dict.stopEntries.get(entryId);
  const list = entry === undefined ? undefined : dict.stopLists.get(entry.listId);
  if (entry === undefined || list === undefined) return null;
  return { list: list.code, listLabel: list.label, note: entry.note, text: message("stop_list_mark", { list: list.label, note: entry.note }) };
}

/**
 * Пересчитать производное всех Индикаторов по Словарю (применение версии, правка Местного расширения):
 * пачками, в транзакции вызывающего. Возвращает, сколько значений получило и потеряло пометку Стоп-листа.
 */
export function recomputeAll(db: Db, dict: AppliedDictionary, onlyTypes?: Set<string>): { stopListGained: number; stopListLost: number; recomputed: number } {
  let gained = 0;
  let lost = 0;
  let recomputed = 0;
  const rows = db.prepare("SELECT r.id, r.fields, v.stopListEntryId FROM record r LEFT JOIN indicator_value v ON v.recordId = r.id WHERE r.type = 'indicator'").all();
  for (const row of rows) {
    const fields = JSON.parse(String(row["fields"])) as Record<string, unknown>;
    if (onlyTypes !== undefined && !onlyTypes.has(dict.canonicalId(String(fields["type"])))) continue;
    const before = row["stopListEntryId"] === null || row["stopListEntryId"] === undefined ? null : String(row["stopListEntryId"]);
    const v = computeIndicatorValue(dict, fields);
    writeIndicatorValue(db, String(row["id"]), v);
    recomputed++;
    if (before === null && v.stopListEntryId !== null) gained++;
    if (before !== null && v.stopListEntryId === null) lost++;
  }
  return { stopListGained: gained, stopListLost: lost, recomputed };
}
