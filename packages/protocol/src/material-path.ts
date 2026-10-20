// Относительный путь Материала в его Кейсе или Документе (BANK-10; research R4 фичи 006): пересечение
// того, что допускают ext4, APFS и NTFS, — дерево Материалов переносится на носитель и читается
// внешними инструментами на любой платформе (APP-21). Ни один сегмент не оканчивается на
// служебный суффикс файла Заверения (research R7). Проверка без регулярных выражений над вводом с
// возвратом (принцип VI конституции): посимвольно.

export const MAX_PATH_SEGMENTS = 32;
export const MAX_SEGMENT_BYTES = 255;
export const ATTESTATION_SUFFIX = ".zaverenie-";

const WINDOWS_RESERVED = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);
/** Знаки, запрещённые в именах NTFS, кроме «/» (разделитель): «\ : * ? " < > |». */
const FORBIDDEN = new Set(["\\", ":", "*", "?", '"', "<", ">", "|"]);

export type MaterialPathRule =
  | "empty"
  | "absolute"
  | "too_many_segments"
  | "empty_segment"
  | "dot_segment"
  | "forbidden_char"
  | "control_char"
  | "trailing_dot_or_space"
  | "reserved_name"
  | "segment_too_long"
  | "not_well_formed"
  | "not_nfc";

export type MaterialPathCheck =
  | { ok: true; pathKey: string }
  | { ok: false; code: "material_path_invalid"; rule: MaterialPathRule }
  | { ok: false; code: "material_path_reserved" };

/** Последний сегмент вида «<имя>.zaverenie-<цифры>.json» — имя файла Заверения (research R7). */
export function isAttestationFileName(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (!lower.endsWith(".json")) return false;
  const stem = lower.slice(0, -".json".length);
  const at = stem.lastIndexOf(ATTESTATION_SUFFIX);
  if (at < 0) return false;
  const digits = stem.slice(at + ATTESTATION_SUFFIX.length);
  if (digits.length === 0) return false;
  for (const ch of digits) if (ch < "0" || ch > "9") return false;
  return true;
}

function checkSegment(segment: string): MaterialPathRule | undefined {
  if (segment.length === 0) return "empty_segment";
  if (segment === "." || segment === "..") return "dot_segment";
  for (const ch of segment) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return "control_char";
    if (FORBIDDEN.has(ch)) return "forbidden_char";
  }
  const last = segment.at(-1);
  if (last === "." || last === " ") return "trailing_dot_or_space";
  const base = (segment.split(".")[0] ?? "").toLowerCase().trimEnd();
  if (WINDOWS_RESERVED.has(base)) return "reserved_name";
  if (new TextEncoder().encode(segment).length > MAX_SEGMENT_BYTES) return "segment_too_long";
  return undefined;
}

/**
 * Проверить путь; pathKey — ключ уникальности в владельце: NFC и нижний регистр (файловые системы macOS
 * и Windows по умолчанию не различают регистр — два Материала легли бы в один файл).
 */
export function checkMaterialPath(path: string): MaterialPathCheck {
  if (typeof path !== "string" || path.length === 0) return { ok: false, code: "material_path_invalid", rule: "empty" };
  if (!path.isWellFormed()) return { ok: false, code: "material_path_invalid", rule: "not_well_formed" };
  if (path.normalize("NFC") !== path) return { ok: false, code: "material_path_invalid", rule: "not_nfc" };
  if (path.startsWith("/")) return { ok: false, code: "material_path_invalid", rule: "absolute" };
  const segments = path.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) return { ok: false, code: "material_path_invalid", rule: "too_many_segments" };
  for (const segment of segments) {
    const rule = checkSegment(segment);
    if (rule !== undefined) return { ok: false, code: "material_path_invalid", rule };
  }
  // Имя файла Заверения не годится ни для файла, ни для каталога: каталог «x.zaverenie-1.json» занял бы
  // место Заверения Материала «x» (research R7).
  if (segments.some(isAttestationFileName)) return { ok: false, code: "material_path_reserved" };
  return { ok: true, pathKey: path.toLowerCase() };
}

/** Имя Заверения номер n рядом с файлом Материала (research R7). */
export function attestationFileName(path: string, n: number): string {
  return `${path}${ATTESTATION_SUFFIX}${n}.json`;
}
