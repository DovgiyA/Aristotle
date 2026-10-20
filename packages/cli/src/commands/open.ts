// aristotel open — ссылка входа в интерфейс с одноразовым токеном запуска на 2 минуты: печатает и
// открывает в браузере (research R14 фичи 004; contracts/cli.md). Токен — файл каталога данных с правами
// владельца: другая учётная запись ОС на этом компьютере его не прочтёт (STATION-08).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readInstall, restrictToOwner, InstallError } from "@aristotel/core";
import { LAUNCH_TOKEN_FILE, LAUNCH_TOKEN_TTL_MS } from "@aristotel/station";
import { message } from "@aristotel/protocol";
import { EXIT, printJson } from "../output.ts";

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

export async function open(args: { dataDir: string; json: boolean; noBrowser: boolean }): Promise<number> {
  const install = readInstall(args.dataDir);
  if (install.role !== "station") throw new InstallError("cli_not_for_role", { role: install.role });
  const token = randomBytes(32).toString("base64url");
  const path = join(args.dataDir, LAUNCH_TOKEN_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ token, expiresAt: Date.now() + LAUNCH_TOKEN_TTL_MS }), { mode: 0o600 });
  restrictToOwner(temp);
  renameSync(temp, path);
  const url = `http://127.0.0.1:${install.port}/vhod#${token}`;
  if (args.json) printJson({ url });
  else process.stdout.write(`${message("cli_open_url")}\n${url}\n`);
  if (!args.noBrowser) openBrowser(url);
  return EXIT.ok;
}
