// aristotel init — задать роль установки и завести первого Старшего (APP-01, ROLE-26; contracts/cli.md).
import { userInfo } from "node:os";
import { existsSync } from "node:fs";
import {
  ROLES,
  InstallError,
  closeDatabase,
  ensureAccessToken,
  ensureTlsKey,
  installPath,
  openBank,
  readAccessToken,
  readInstall,
  startServer,
  writeInstall,
  type Install,
  type Role,
} from "@aristotel/core";
import { STATION_DEFAULT_PORT, isGroupCode, isRelayUrl, message, tlsSpkiGroups, type Member } from "@aristotel/protocol";
import { ApiClient, ClientError } from "../client.ts";
import { writeCliMember } from "../cli-member.ts";
import { EXIT, printFields, printJson, printError } from "../output.ts";

export interface InitArgs {
  dataDir: string;
  json: boolean;
  role: string | undefined;
  seniorLabel: string | undefined;
  port: number | undefined;
  /** Роль relay: Код Группы-хозяина, свой адрес https://, адрес прослушивания (research R3 фичи 004). */
  group?: string | undefined;
  url?: string | undefined;
  listen?: string | undefined;
}

/** init --role relay: install.json, TLS-ключ и сертификат; печатает отпечаток для Реестра (RELAY-16). */
function initRelay(args: InitArgs): number {
  if (args.group === undefined || args.url === undefined) {
    printError(message("cli_relay_group_missing"));
    return EXIT.refused;
  }
  if (!isGroupCode(args.group)) {
    printError(message("cli_relay_group_format"));
    return EXIT.refused;
  }
  if (!isRelayUrl(args.url)) {
    printError(message("cli_relay_url_format"));
    return EXIT.refused;
  }
  const url = new URL(args.url);
  const listen = args.listen ?? `0.0.0.0:${url.port === "" ? 443 : url.port}`;
  const port = Number(listen.slice(listen.lastIndexOf(":") + 1));
  const install = writeInstall(args.dataDir, { role: "relay", port, relay: { group: args.group, listen, url: args.url } });
  const tls = ensureTlsKey(args.dataDir);
  const result = { role: "relay", installId: install.installId, dataDir: args.dataDir, group: args.group, url: args.url, listen, tlsSpki: tls.tlsSpki };
  if (args.json) printJson(result);
  else
    printFields([
      [message("label_role"), "relay"],
      [message("label_data_dir"), args.dataDir],
      [message("label_group_code"), args.group],
      [message("label_tls_spki"), tls.tlsSpki],
      [message("label_tls_groups"), tlsSpkiGroups(tls.tlsSpki)],
    ]);
  return EXIT.ok;
}

export async function init(args: InitArgs): Promise<number> {
  if (args.role === undefined || !ROLES.includes(args.role as Role)) {
    printError(new InstallError("role_unknown", { role: args.role ?? "" }).message);
    return EXIT.refused;
  }
  const role = args.role as Role;
  if (role === "relay") {
    if (existsSync(installPath(args.dataDir))) throw new InstallError("role_already_set", { role: readInstall(args.dataDir).role });
    return initRelay(args);
  }
  // Подпись проверяется до записи файлов: без неё Опорная станция осталась бы без первого Старшего.
  if (role === "base-station" && (args.seniorLabel === undefined || args.seniorLabel.trim() === "")) {
    printError(message("cli_senior_label_missing"));
    return EXIT.refused;
  }

  let install: Install;
  if (existsSync(installPath(args.dataDir))) {
    // Повтор после сбоя: роль уже записана, а первого Старшего нет — доводим заведение (FR-003).
    // Другая роль — отказ; уже заведённый Старший — отказ ниже, по ответу службы.
    install = readInstall(args.dataDir);
    if (install.role !== role || role !== "base-station") throw new InstallError("role_already_set", { role: install.role });
    ensureAccessToken(args.dataDir);
  } else {
    // Станция: порт интерфейса на 127.0.0.1, по умолчанию 47321 (research R14 фичи 004).
    const port = args.port ?? (role === "station" ? STATION_DEFAULT_PORT : undefined);
    install = writeInstall(args.dataDir, port === undefined ? { role } : { role, port });
  }
  if (role !== "base-station") {
    if (args.json) printJson({ role, installId: install.installId, dataDir: args.dataDir });
    else printFields([[message("label_role"), role], [message("label_data_dir"), args.dataDir]]);
    return EXIT.ok;
  }

  // Банк создаётся здесь (BANK-01), первый Старший — через API временно поднятой службы (BANK-06).
  closeDatabase(openBank(args.dataDir, install));
  const server = await startServer({ dataDir: args.dataDir, port: 0 });
  try {
    const client = new ApiClient({ port: server.port, token: readAccessToken(args.dataDir) });
    let member: Member;
    try {
      member = await client.request<Member>("POST", "/api/members/bootstrap", {
        label: args.seniorLabel,
        osAccount: userInfo().username,
      });
    } catch (error) {
      if (error instanceof ClientError && error.code === "already_bootstrapped") {
        throw new InstallError("role_already_set", { role: install.role });
      }
      throw error;
    }
    writeCliMember(args.dataDir, member.id);
    if (args.json) printJson({ role, installId: install.installId, dataDir: args.dataDir, memberId: member.id });
    else
      printFields([
        [message("label_role"), role],
        [message("label_data_dir"), args.dataDir],
        [message("label_first_senior"), `${member.label} (${member.id})`],
      ]);
    return EXIT.ok;
  } finally {
    await server.close();
  }
}
