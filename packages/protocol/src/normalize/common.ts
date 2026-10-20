// Общее для Классов нормализации (research R7 фичи 005): результат, окружение, пробелы Unicode.

/** Результат нормализации: форма или «не нормализуется» с причиной (DICT-39). */
export type NormResult = { ok: true; value: string } | { ok: false; reason: string };

/** То, чего в браузере и в Node нет одной функцией: IDNA (UTS #46) — url.domainToASCII или URL. */
export interface NormEnv {
  toAscii: (domain: string) => string;
}

export const ok = (value: string): NormResult => ({ ok: true, value });
export const fail = (reason: string): NormResult => ({ ok: false, reason });

/** Свойство White_Space Unicode 17.0 (PropList.txt) — не `\s` JavaScript: без U+FEFF, с U+0085. */
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const EDGES = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const RUNS = new RegExp(`[${WS}]+`, "g");

export const trimSpace = (s: string): string => s.replace(EDGES, "");
export const collapseSpace = (s: string): string => s.replace(RUNS, " ");
export const removeSpace = (s: string): string => s.replace(RUNS, "");
