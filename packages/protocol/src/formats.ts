// Форматы значений §5 приложения «Словарь Сети v1» (research R8 фичи 005). Нарушение формата —
// пометка значения, а не отказ сохранения: отправку на Проверку блокирует фича 008 (INTAKE-06).
// Значение вне открытого перечня — «вне Словаря» (DICT-14), вне закрытого — отказ (DICT-60).
import { message } from "./messages.ts";
import names from "./slovar-names.json" with { type: "json" };
import { parseCidr, parseIp } from "./normalize/ip.ts";
import { trimSpace } from "./normalize/common.ts";
import { isDomainShape, isNumericHost } from "./normalize/domen.ts";

export type FormatResult = "ok" | "format_violation" | "out_of_dictionary" | "closed_violation" | "not_a_value";

export interface FormatContext {
  /** IDNA (UTS #46) — как в нормализации «домен». */
  toAscii: (domain: string) => string;
  /** Коды значений перечня по его Коду; неизвестный перечень — undefined. */
  enumCodes: (enumCode: string) => ReadonlySet<string> | undefined;
  /** Закрытый перечень поля программы (DICT-60). */
  closedEnum: (enumCode: string) => boolean;
}

export type ParsedFormat =
  | { kind: "hex"; min: number; max: number; multiple: false }
  | { kind: "guid" | "hostname" | "domain" | "ip" | "ip-cidr" | "url" | "ssh-key" | "datetime" | "tile" | "geo" | "param"; multiple: false }
  | { kind: "base64"; length: number; multiple: false }
  | { kind: "serial"; digits?: { min: number; max: number }; multiple: false }
  | { kind: "string"; max: number; noSpaces: boolean; multiple: false }
  | { kind: "integer"; min?: number; max?: number; multiple: false }
  | { kind: "enum"; enumCode: string; multiple: boolean };

/** Строка формата не по §5 — ошибка данных Словаря: сборка и применение версии её не пропускают. */
export class FormatSpecError extends Error {}

const N = names.formats;
/** Имена форматов §5 так, как их пишет Словарь (slovar-names.json). */
export const FORMAT_NAMES: Readonly<typeof names.formats> = N;
const SIMPLE_KINDS = ["guid", "hostname", "domain", "ip", "ip-cidr", "url", "ssh-key", "datetime", "tile", "geo", "param"] as const;
const SIMPLE = new Map<string, ParsedFormat["kind"]>(SIMPLE_KINDS.map((kind) => [N[kind], kind]));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HEX_RE = new RegExp(`^${escape(N.hex)}:(\\d+)(?:\\.\\.(\\d+))?$`);
const BASE64_RE = new RegExp(`^${escape(N.base64)}:(\\d+)$`);
const DIGITS_RE = new RegExp(`^(\\d+)(?:–(\\d+))? ${escape(N.digits)}$`);
const STRING_RE = new RegExp(`^${escape(N.string)}:(\\d+)( ${escape(N.noSpaces)})?$`);
const INTEGER_RE = new RegExp(`^${escape(N.integer)}(?::(\\d+)–(\\d+))?$`);
const ENUM_RE = new RegExp(`^${escape(N.enum)}:([a-z][a-z0-9_]*)( ${escape(N.multiple)})?$`);

/** Разобрать строку формата Словаря; пояснение в скобках после формата («hex:8 (vvvv:pppp)») — подсказка людям. */
export function parseFormat(spec: string): ParsedFormat {
  const fail = (): never => {
    throw new FormatSpecError(message("format_spec_unknown", { spec }));
  };
  let base = spec.trim();
  let hint = "";
  const paren = base.indexOf(" (");
  if (paren >= 0 && base.endsWith(")")) {
    hint = base.slice(paren + 2, -1);
    base = base.slice(0, paren);
  }
  const simple = SIMPLE.get(base);
  if (simple !== undefined) return { kind: simple, multiple: false } as ParsedFormat;
  let m = HEX_RE.exec(base);
  if (m !== null) return { kind: "hex", min: Number(m[1]), max: Number(m[2] ?? m[1]), multiple: false };
  m = BASE64_RE.exec(base);
  if (m !== null) return { kind: "base64", length: Number(m[1]), multiple: false };
  if (base === N.serial) {
    if (hint === "") return { kind: "serial", multiple: false };
    const d = DIGITS_RE.exec(hint);
    if (d === null) return fail();
    return { kind: "serial", digits: { min: Number(d[1]), max: Number(d[2] ?? d[1]) }, multiple: false };
  }
  m = STRING_RE.exec(base);
  if (m !== null) return { kind: "string", max: Number(m[1]), noSpaces: m[2] !== undefined, multiple: false };
  m = INTEGER_RE.exec(base);
  if (m !== null) {
    return m[1] === undefined ? { kind: "integer", multiple: false } : { kind: "integer", min: Number(m[1]), max: Number(m[2]), multiple: false };
  }
  m = ENUM_RE.exec(base);
  if (m !== null) return { kind: "enum", enumCode: m[1]!, multiple: m[2] !== undefined };
  return fail();
}

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const DATE = "\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}(?::\\d{2}(?::\\d{2}(?:\\.\\d+)?)?)?(?:Z|[+-]\\d{2}:\\d{2})?)?";
const DATETIME = new RegExp(`^${DATE}(?:/${DATE})?$`);
const COORD = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;

const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|([+-])(\d{2}):(\d{2}))?)?$/;

/**
 * Момент ISO 8601 с точностью до дня, часа или секунды (приложение §5): существующая дата, час 0–23,
 * минута и секунда 0–59, зона ±ЧЧ:ММ; без зоны — UTC. Свой разбор, без Date.parse: он «доворачивает»
 * 30 февраля до марта (T266). undefined — не момент.
 */
export function isoInstant(s: string): number | undefined {
  const m = DATE_PART.exec(s);
  if (m === null) return undefined;
  const [y, mo, d, h = "0", mi = "0", se = "0"] = [m[1]!, m[2]!, m[3]!, m[4], m[5], m[6]].map((x) => x ?? undefined) as string[];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  if (Number(h) > 23 || Number(mi) > 59 || Number(se) > 59) return undefined;
  let offset = 0;
  if (m[8] !== undefined) {
    if (Number(m[9]) > 23 || Number(m[10]) > 59) return undefined;
    offset = (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  }
  return Date.UTC(year, month - 1, day, Number(h), Number(mi), Number(se)) - offset * 60_000;
}

/** Дата или диапазон «начало/конец»: обе части — моменты, начало не позже конца (T266). */
function validDate(s: string): boolean {
  const parts = s.split("/").map(isoInstant);
  if (parts.some((p) => p === undefined)) return false;
  return parts.length === 1 || parts[0]! <= parts[1]!;
}

function validPoint(s: string): boolean {
  const m = COORD.exec(s);
  if (m === null) return false;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function check(f: ParsedFormat, v: string, ctx: FormatContext): boolean {
  switch (f.kind) {
    case "hex": {
      const digits = v.replace(/^0x/i, "").replace(/[:\-\s]/g, "");
      return /^[0-9a-fA-F]+$/.test(digits) && digits.length >= f.min && digits.length <= f.max;
    }
    case "guid":
      return /^(\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}|[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/.test(v);
    case "hostname":
      return v.length <= 253 && v.split(".").every((l) => HOST_LABEL.test(l));
    case "domain": {
      if (!isDomainShape(v)) return false;
      const ascii = ctx.toAscii(v).replace(/\.$/, "");
      if (isNumericHost(ascii)) return false;
      return ascii !== "" && ascii.split(".").length >= 2 && ascii.split(".").every((l) => l.length > 0);
    }
    case "ip":
      return parseIp(v) !== undefined;
    case "ip-cidr":
      return parseCidr(v) !== undefined;
    case "url":
      return URL.canParse(v) && /^[a-z][a-z0-9+.-]*:/i.test(v);
    case "ssh-key":
      return /^SHA256:[A-Za-z0-9+/]{43}$/.test(v) || /^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}(?: .*)?$/.test(v);
    case "base64":
      return v.length === f.length && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
    case "serial":
      if (f.digits !== undefined) return /^\d+$/.test(v) && v.length >= f.digits.min && v.length <= f.digits.max;
      // Печатные знаки: без управляющих и невидимых форматирующих (нулевой ширины, BOM, мягкий перенос; T284).
      return [...v].length <= 64 && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(v);
    case "string":
      // Одна строка: никакого разделителя строк Юникода (T286).
      return [...v].length <= f.max && !/[\r\n\u000b\u000c\u0085\u2028\u2029]/.test(v) && !(f.noSpaces && /\s/.test(v));
    case "integer": {
      const digits = v.replace(/[   _]/g, "");
      if (!/^-?\d+$/.test(digits)) return false;
      const n = Number(digits);
      return (f.min === undefined || n >= f.min) && (f.max === undefined || n <= f.max);
    }
    case "datetime":
      return DATETIME.test(v) && validDate(v);
    case "tile":
      return /^[NS]\d{2}[EW]\d{3}$/.test(v);
    case "geo": {
      // Точка или многоугольник WGS 84 и, через пробел, Код точности (DICT-65; приложение §5); есть ли
      // Код в перечне geo_precision — в checkFormat.
      const [shape = "", precision, ...rest] = v.split(" ");
      if (rest.length > 0 || (precision !== undefined && !/^[a-z0-9][a-z0-9_]*$/.test(precision))) return false;
      const points = shape.split(";");
      return (points.length === 1 || points.length >= 3) && points.every(validPoint);
    }
    case "param":
      return /^[^=\s]+=.*$/.test(v);
    case "enum":
      return true;
  }
}

/** Проверить значение по формату типа (§5 приложения). */
export function checkFormat(f: ParsedFormat, value: string, ctx: FormatContext): FormatResult {
  const v = trimSpace(value);
  if (v === "") return "not_a_value";
  if (f.kind === "enum") {
    const codes = ctx.enumCodes(f.enumCode);
    if (codes !== undefined && codes.has(v)) return "ok";
    return ctx.closedEnum(f.enumCode) ? "closed_violation" : "out_of_dictionary";
  }
  if (!check(f, v, ctx)) return "format_violation";
  // Точность «гео» вне перечня geo_precision — как значение вне перечня, а не нарушение формата (DICT-65, DICT-14).
  if (f.kind === "geo") {
    const precision = v.split(" ")[1];
    const codes = ctx.enumCodes(GEO_PRECISION);
    if (precision !== undefined && codes !== undefined && !codes.has(precision)) return ctx.closedEnum(GEO_PRECISION) ? "closed_violation" : "out_of_dictionary";
  }
  return "ok";
}

/** Перечень точности формата «гео» (DICT-65; приложение §7). */
const GEO_PRECISION = "geo_precision";
