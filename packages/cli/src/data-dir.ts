// Каталог данных программы по умолчанию — каталог ОС для данных приложений.
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDataDir(): string {
  const env = process.env;
  if (process.platform === "win32") return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Aristotel");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Aristotel");
  return join(env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "aristotel");
}
