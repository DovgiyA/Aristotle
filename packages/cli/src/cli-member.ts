// Автор действий CLI по умолчанию — первый Старший, заведённый init (research R11; contracts/cli.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "cli.json";

export function writeCliMember(dataDir: string, memberId: string): void {
  writeFileSync(join(dataDir, FILE), JSON.stringify({ memberId }, null, 2) + "\n", { mode: 0o600 });
}

/** Член Группы, от имени которого действует CLI: --as или первый Старший из cli.json. */
export function cliMember(dataDir: string, override: string | undefined): string | undefined {
  if (override !== undefined) return override;
  const path = join(dataDir, FILE);
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, "utf8")) as { memberId?: string }).memberId;
}
