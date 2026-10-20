// Пароль Ключа Координатора: с терминала без эха (create — дважды) или из файла --password-file —
// первая строка без перевода строки. В аргументах и переменных окружения пароль не принимается;
// короче 12 знаков — отказ (research R6 фичи 003; contracts/cli.md «Пароль Ключа Координатора»).
import { readFileSync } from "node:fs";
import { message } from "@aristotel/protocol";

export const MIN_PASSWORD_LENGTH = 12;

export class PasswordError extends Error {}

/** Прочитать строку с терминала, не показывая вводимое. */
function askHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new PasswordError(message("password_no_terminal")));
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new PasswordError(message("password_cancelled")));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function checkLength(password: string): string {
  if ([...password].length < MIN_PASSWORD_LENGTH) throw new PasswordError(message("password_too_short", { min: MIN_PASSWORD_LENGTH }));
  return password;
}

/**
 * Пароль из файла или с терминала; confirm — спросить дважды и сверить (заведение ключа); member —
 * пароль Члена Группы для Ключа станции (STATION-09), а не Ключа Координатора.
 */
export async function readPassword(options: { file: string | undefined; confirm: boolean; member?: boolean }): Promise<string> {
  if (options.file !== undefined) {
    const first = readFileSync(options.file, "utf8").split(/\r?\n/)[0] ?? "";
    return checkLength(first);
  }
  const prompt = options.member === true ? message("password_prompt_member") : message("password_prompt");
  const password = checkLength(await askHidden(prompt));
  if (options.confirm && (await askHidden(message("password_prompt_again"))) !== password) {
    throw new PasswordError(message("password_mismatch"));
  }
  return password;
}
