// Куда идёт CLI — по роли каталога данных (APP-34, APP-08; contracts/cli.md фичи 004):
// Опорная станция — API сопровождения на loopback, автор — --as или cli.json (фичи 002, 003);
// Станция — API локальной части с токеном локального доступа, автор — Член Группы Станции, --as не
// принимается; действие с подтверждением присутствия — пароль заново и повтор (STATION-12).
import { readAccessToken, readInstall, InstallError } from "@aristotel/core";
import { message } from "@aristotel/protocol";
import { ApiClient, ClientError } from "./client.ts";
import { cliMember } from "./cli-member.ts";
import { readPassword } from "./password.ts";

let presencePasswordFile: string | undefined;

/** --password-file для подтверждения присутствия на Станции (main.ts задаёт один раз). */
export function setPresencePasswordFile(path: string | undefined): void {
  presencePasswordFile = path;
}

export function serviceClient(dataDir: string, as: string | undefined): ApiClient {
  const install = readInstall(dataDir);
  const token = readAccessToken(dataDir);
  if (install.role === "station") {
    if (as !== undefined) throw new InstallError("cli_as_on_station");
    const client = new ApiClient({ port: install.port, token });
    // 403 presence_required — спросить пароль, получить подпись у локальной части и повторить.
    client.onPresenceRequired = async (method, path, body) => {
      const password = await readPassword({ file: presencePasswordFile, confirm: false, member: true });
      const local = new ApiClient({ port: install.port, token });
      try {
        const res = await local.request<{ presence: string }>("POST", "/local/presence", { password, method, path, body });
        return res.presence;
      } catch (error) {
        if (error instanceof ClientError && error.code === "password_wrong") throw new ClientError("password_wrong", message("password_wrong"), 403);
        throw error;
      }
    };
    return client;
  }
  if (install.role !== "base-station") throw new InstallError("cli_not_for_role", { role: install.role });
  const memberId = cliMember(dataDir, as);
  return new ApiClient(memberId === undefined ? { port: install.port, token } : { port: install.port, token, memberId });
}
