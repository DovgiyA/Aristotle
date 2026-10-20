// Таблица NFKC_Casefold для Класса нормализации `строка-без-регистра` (DICT-28; research R7 фичи 005).
// Читает DerivedNormalizationProps.txt нужной версии Unicode (файл с unicode.org/Public/<версия>/ucd/,
// в репозиторий не коммитится) и пишет packages/protocol/src/normalize/nfkc-cf-table.ts.
//
// Запуск: node tools/unicode/nfkc-cf.ts <DerivedNormalizationProps.txt>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UNICODE_VERSION = "17.0";
const OUT = join(import.meta.dirname, "../../packages/protocol/src/normalize/nfkc-cf-table.ts");

const source = process.argv[2];
if (source === undefined) {
  process.stderr.write("usage: node tools/unicode/nfkc-cf.ts <DerivedNormalizationProps.txt>\n");
  process.exit(2);
}
const text = readFileSync(source, "utf8");
const header = text.split("\n", 1)[0] ?? "";
if (!header.includes(`DerivedNormalizationProps-${UNICODE_VERSION}.`)) {
  process.stderr.write(`expected Unicode ${UNICODE_VERSION}, got: ${header}\n`);
  process.exit(2);
}

// Строки вида «0041 ; NFKC_CF; 0061 # …», «00AD ; NFKC_CF; # …» (удаление) и диапазоны «XXXX..YYYY».
const rows: [number, number, string][] = [];
for (const line of text.split("\n")) {
  const data = line.split("#", 1)[0]?.trim() ?? "";
  if (data === "") continue;
  const fields = data.split(";").map((f) => f.trim());
  if (fields[1] !== "NFKC_CF") continue;
  const [range = "", , mapping = ""] = fields;
  const [from = "", to = from] = range.split("..");
  const value = mapping === "" ? "" : String.fromCodePoint(...mapping.split(/\s+/).map((h) => parseInt(h, 16)));
  rows.push([parseInt(from, 16), parseInt(to, 16), value]);
}
rows.sort((a, b) => a[0] - b[0]);

// Соседние диапазоны с одним отображением сливаются: таблица короче, поиск тот же.
const merged: [number, number, string][] = [];
for (const row of rows) {
  const last = merged[merged.length - 1];
  if (last !== undefined && last[1] + 1 === row[0] && last[2] === row[2]) last[1] = row[1];
  else merged.push([...row]);
}

// Замена — массивом кодов: таблица не несёт букв (тест «нет русских литералов в src», принцип VIII).
const body = merged.map(([a, b, v]) => `[${a},${b},[${[...v].map((c) => c.codePointAt(0)).join(",")}]]`).join(",\n");
writeFileSync(
  OUT,
  `// Собрано tools/unicode/nfkc-cf.ts из DerivedNormalizationProps.txt Unicode ${UNICODE_VERSION} (свойство NFKC_CF).
// Не править руками: другая версия Unicode — другой Класс нормализации (DICT-26).
export const UNICODE_VERSION = "${UNICODE_VERSION}";

/** [первый код, последний код, коды замены]; пустая замена — символ удаляется. Отсортировано по коду. */
export const NFKC_CF_TABLE: readonly (readonly [number, number, readonly number[]])[] = [
${body},
];
`,
);
process.stdout.write(`${merged.length} ranges from ${rows.length} rows -> ${OUT}\n`);
