// Совпадение значения со строками Стоп-листа (research R9 фичи 005; DICT-40, DICT-41): «значение» —
// равенство нормализованных форм того же типа, «диапазон» — CIDR (только тип с Классом `ip`),
// «шаблон» — glob «*» и «?» по нормализованной форме, без классов символов и без регулярных выражений.
import { message } from "./messages.ts";
import { inCidr, parseCidr, parseIp, type Cidr } from "./normalize/ip.ts";
import { normalize } from "./normalize/index.ts";
import { trimSpace, type NormEnv } from "./normalize/common.ts";
import names from "./slovar-names.json" with { type: "json" };

export type StopListKind = "value" | "range" | "pattern";

export interface StopListEntryInput {
  id: string;
  typeId: string;
  kind: StopListKind;
  /** Нормализованная форма значения строки; у диапазона — CIDR, у шаблона — glob. */
  normalized: string;
}

export interface StopListMatcher {
  match(typeId: string, normalized: string): StopListEntryInput | undefined;
}

export class StopListMatcherError extends Error {}

/** glob: «*» — любая строка, «?» — один символ (кодовая точка); остальное — буквально. */
export function globMatch(pattern: string, text: string): boolean {
  const p = [...pattern];
  const s = [...text];
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

export function buildStopListMatcher(entries: Iterable<StopListEntryInput>, normClassOf: (typeId: string) => string | null | undefined): StopListMatcher {
  const values = new Map<string, Map<string, StopListEntryInput>>();
  const ranges = new Map<string, { cidr: Cidr; entry: StopListEntryInput }[]>();
  const patterns = new Map<string, StopListEntryInput[]>();
  for (const entry of entries) {
    if (entry.kind === "value") {
      let byValue = values.get(entry.typeId);
      if (byValue === undefined) values.set(entry.typeId, (byValue = new Map()));
      if (!byValue.has(entry.normalized)) byValue.set(entry.normalized, entry);
    } else if (entry.kind === "range") {
      const cidr = parseCidr(entry.normalized);
      if (normClassOf(entry.typeId) !== "ip" || cidr === undefined) {
        throw new StopListMatcherError(message("stop_list_range_not_ip", { id: entry.id }));
      }
      const list = ranges.get(entry.typeId) ?? [];
      list.push({ cidr, entry });
      ranges.set(entry.typeId, list);
    } else {
      const list = patterns.get(entry.typeId) ?? [];
      list.push(entry);
      patterns.set(entry.typeId, list);
    }
  }
  return {
    match(typeId, normalized) {
      const exact = values.get(typeId)?.get(normalized);
      if (exact !== undefined) return exact;
      const typeRanges = ranges.get(typeId);
      if (typeRanges !== undefined) {
        const ip = parseIp(normalized);
        if (ip !== undefined) for (const r of typeRanges) if (inCidr(ip, r.cidr)) return r.entry;
      }
      for (const p of patterns.get(typeId) ?? []) if (globMatch(p.normalized, normalized)) return p;
      return undefined;
    },
  };
}

/** Знаки нормализованной формы Класса — буквальные части шаблона из других знаков не совпадут ни с чем. */
const N = names.normClasses;
const PATTERN_ALPHABET: Record<string, RegExp> = {
  [N.imyaHosta]: /^[a-z0-9-]*$/,
  [N.domen]: /^[a-z0-9.-]*$/,
  [N.hex]: /^[0-9a-f]*$/,
  [N.guid]: /^[0-9a-f-]*$/,
  [N.ip]: /^[0-9a-f.:]*$/,
  // Нормализованное целое — без знака и разделителей; отпечаток ssh — base64 без префикса SHA256: (T270).
  [N.tseloe]: /^[0-9]*$/,
  [N.sshKlyuch]: /^[A-Za-z0-9+/]*$/,
};

/**
 * Нормальная форма шаблона Стоп-листа — одна для сборки, применения и «Местного» (DICT-41; T258):
 * шаблон приводится Классом, когда Класс его принимает (`*.Пример.РФ` → A-метки); иначе его буквальные
 * части — уже знаки нормализованной формы (`192.168.*`, `fe80::*`). undefined — шаблон не совпадёт ни с
 * одним нормализованным значением (`OrangePi*` у имени хоста).
 */
export function patternNormalForm(normClass: string | null | undefined, pattern: string, env: NormEnv): string | undefined {
  const trimmed = trimSpace(pattern);
  if (normClass === null || normClass === undefined) return trimmed;
  const n = normalize(normClass, trimmed, env);
  if (n.ok) return n.value;
  const alphabet = Object.hasOwn(PATTERN_ALPHABET, normClass) ? PATTERN_ALPHABET[normClass] : undefined;
  if (alphabet === undefined) return trimmed;
  return trimmed.split(/[*?]/).every((chunk) => alphabet.test(chunk)) ? trimmed : undefined;
}
