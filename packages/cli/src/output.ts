import { isMessageCode, message } from "@aristotel/protocol";

// Вывод CLI: таблица для человека или JSON для сценариев (APP-08; contracts/cli.md).

/** Коды выхода CLI: 0 — успех, 1 — отказ или неверные аргументы, 2 — служба недоступна, 3 — версия API. */
export const EXIT = { ok: 0, refused: 1, unavailable: 2, apiVersion: 3 } as const;

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Таблица «поле — значение» для одного объекта; to — куда писать (сводка при --json — в stderr). */
export function printFields(rows: [string, string][], to: NodeJS.WriteStream = process.stdout): void {
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, value] of rows) to.write(`${name.padEnd(width)}  ${value}\n`);
}

/** Таблица со столбцами для списка объектов. */
export function printTable(columns: string[], rows: string[][]): void {
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  process.stdout.write(line(columns) + "\n");
  for (const row of rows) process.stdout.write(line(row) + "\n");
}

/**
 * Подпись значения-ключа по-русски (конституция VIII): `label_<prefix>_<key>` из locales/ru.json;
 * ключа нет в словаре — как есть.
 */
export function keyLabel(prefix: string, key: string): string {
  const code = `label_${prefix}_${key}`;
  return isMessageCode(code) ? message(code) : key;
}

export function printError(text: string): void {
  process.stderr.write(message("cli_error", { text }) + "\n");
}
