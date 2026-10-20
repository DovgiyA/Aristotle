#!/usr/bin/env node
// CLI aristotel — каркас APP-08: разбор команд, общие флаги, коды выхода (research R12; contracts/cli.md).
import { parseArgs } from "node:util";
import { DictionaryBuildError, InstallError } from "@aristotel/core";
import { API_VERSIONS, PROGRAM_VERSION, SlovarFormatError, message } from "@aristotel/protocol";
import { ClientError } from "./client.ts";
import { defaultDataDir } from "./data-dir.ts";
import { EXIT, printError } from "./output.ts";
import { init } from "./commands/init.ts";
import { serve } from "./commands/serve.ts";
import { status } from "./commands/status.ts";
import { record } from "./commands/record.ts";
import { journal } from "./commands/journal.ts";
import { member } from "./commands/member.ts";
import { groupKey } from "./commands/group-key.ts";
import { coordinatorKey } from "./commands/coordinator-key.ts";
import { registry, RegistryFileError } from "./commands/registry.ts";
import { dictionary, DictionaryFileError } from "./commands/dictionary.ts";
import { caseCommand } from "./commands/case.ts";
import { form } from "./commands/form.ts";
import { local } from "./commands/local.ts";
import { relay } from "./commands/relay.ts";
import { tls } from "./commands/tls.ts";
import { station } from "./commands/station.ts";
import { invitation } from "./commands/invitation.ts";
import { stations } from "./commands/stations.ts";
import { material } from "./commands/material.ts";
import { setPresencePasswordFile } from "./service-client.ts";
import { open } from "./commands/open.ts";
import { KeyFileError } from "./key-file.ts";
import { PasswordError } from "./password.ts";

const USAGE = message("cli_usage");

/** Автор не задан флагом --as — CLI действует от имени Члена Группы из cli.json (research R9). */
let authorFromCliJson = true;

async function main(argv: string[]): Promise<number | undefined> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      json: { type: "boolean", default: false },
      role: { type: "string" },
      "senior-label": { type: "string" },
      port: { type: "string" },
      as: { type: "string" },
      label: { type: "string" },
      "expected-version": { type: "string" },
      member: { type: "string" },
      record: { type: "string" },
      action: { type: "string" },
      limit: { type: "string" },
      after: { type: "string" },
      cursor: { type: "string" },
      all: { type: "boolean", default: false },
      out: { type: "string" },
      "password-file": { type: "string" },
      "member-password-file": { type: "string" },
      key: { type: "string" },
      yes: { type: "boolean", default: false },
      code: { type: "string" },
      "add-relay": { type: "string", multiple: true },
      "remove-relay": { type: "string", multiple: true },
      number: { type: "string" },
      document: { type: "boolean", default: false },
      group: { type: "string" },
      url: { type: "string" },
      listen: { type: "string" },
      senior: { type: "string" },
      "no-browser": { type: "boolean", default: false },
      handover: { type: "boolean", default: false },
      source: { type: "string" },
      previous: { type: "string" },
      "stop-list": { type: "string", multiple: true },
      kind: { type: "string" },
      type: { type: "string" },
      fields: { type: "string" },
      class: { type: "string" },
      subtype: { type: "string" },
      "on-linux": { type: "boolean", default: false },
      "json-payload": { type: "string" },
      state: { type: "string" },
      case: { type: "string" },
      reason: { type: "string" },
      path: { type: "string" },
      attestation: { type: "string" },
      file: { type: "string" },
      station: { type: "string" },
      deleted: { type: "boolean", default: false },
      attestations: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });
  const [command] = positionals;
  authorFromCliJson = values.as === undefined;
  // Пароль Члена Группы для подтверждения присутствия: --member-password-file, иначе --password-file.
  setPresencePasswordFile(values["member-password-file"] ?? values["password-file"]);
  if (values.version === true) {
    process.stdout.write(`aristotel ${PROGRAM_VERSION}, API: ${API_VERSIONS.join(", ")}\n`);
    return EXIT.ok;
  }
  const dataDir = values["data-dir"] ?? defaultDataDir();
  const json = values.json ?? false;
  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? EXIT.refused : EXIT.ok;
  }
  switch (command) {
    case "init": {
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
        printError(message("cli_bad_port", { value: values.port ?? "" }));
        return EXIT.refused;
      }
      return init({ dataDir, json, role: values.role, seniorLabel: values["senior-label"], port, group: values.group, url: values.url, listen: values.listen });
    }
    case "serve":
      return serve({ dataDir });
    case "status":
      return status({ dataDir, json, as: values.as });
    case "record":
      return record({
        dataDir,
        json,
        as: values.as,
        action: positionals[1],
        id: positionals[2],
        secretAction: positionals[2],
        secretId: positionals[3],
        expectedVersion: values["expected-version"],
        type: values.type,
        fields: values.fields,
      });
    case "local":
      return local({ dataDir, json, as: values.as, action: positionals[1], value: positionals[2], payloadFile: values["json-payload"], state: values.state, reason: values.reason });
    case "form":
      return form({ dataDir, json, as: values.as, class: values.class, subtype: values.subtype, onLinux: values["on-linux"] === true });
    case "case":
      return caseCommand({ dataDir, json, as: values.as, action: positionals[1], id: positionals[2] });
    case "member":
      return member({
        dataDir,
        json,
        as: values.as,
        action: positionals[1],
        id: positionals[2],
        label: values.label,
        role: values.role,
        expectedVersion: values["expected-version"],
      });
    case "journal":
      return journal({
        dataDir,
        json,
        as: values.as,
        member: values.member,
        record: values.record,
        case: values.case,
        action: values.action,
        limit: values.limit,
        after: values.after,
        cursor: values.cursor,
        all: values.all ?? false,
      });
    case "group-key":
      return groupKey({ dataDir, json, as: values.as });
    case "registry":
      return registry({
        dataDir,
        json,
        as: values.as,
        action: positionals[1],
        path: positionals[2],
        out: values.out,
        key: values.key,
        passwordFile: values["password-file"],
        yes: values.yes ?? false,
        code: values.code,
        addRelay: values["add-relay"] ?? [],
        removeRelay: values["remove-relay"] ?? [],
        number: values.number,
        document: values.document ?? false,
      });
    case "dictionary":
      return dictionary({
        dataDir,
        json,
        as: values.as,
        action: positionals[1],
        path: positionals[2],
        out: values.out,
        key: values.key,
        passwordFile: values["password-file"],
        yes: values.yes ?? false,
        source: values.source,
        previous: values.previous,
        stopList: values["stop-list"] ?? [],
        number: values.number,
        kind: values.kind,
        code: values.code,
      });
    case "coordinator-key":
      return coordinatorKey({
        dataDir,
        json,
        as: values.as,
        action: positionals[1],
        path: positionals[2],
        out: values.out,
        passwordFile: values["password-file"],
      });
    case "relay":
      return relay({ dataDir, json, action: positionals[1], sub: positionals[2], path: positionals[3] });
    case "tls":
      return tls({ dataDir, json, action: positionals[1] });
    case "station":
      return station({ dataDir, json, action: positionals[1], value: positionals[2], passwordFile: values["password-file"] });
    case "open":
      return open({ dataDir, json, noBrowser: values["no-browser"] ?? false });
    case "stations":
      return stations({ dataDir, json, action: positionals[1], id: positionals[2], handover: values.handover === true });
    case "material":
      return material({
        dataDir,
        json,
        action: positionals[1],
        value: positionals[2],
        value2: positionals[3],
        case: values.case,
        path: values.path,
        kind: values.kind,
        attestation: values.attestation,
        file: values.file,
        station: values.station,
        reason: values.reason,
        deleted: values.deleted === true,
        attestations: values.attestations === true,
        wait: values.wait === true,
      });
    case "invitation":
      return invitation({ dataDir, json, action: positionals[1], senior: values.senior, out: values.out, id: positionals[2] });
    default:
      printError(`${message("cli_unknown_command", { command })}\n\n${USAGE}`);
      return EXIT.refused;
  }
}

// Читатель вывода закрыл канал раньше (`| head`): остальной вывод некуда писать, команда доделывается
// и выходит со своим кодом, без стека необработанного EPIPE.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
  printError(message("cli_unexpected", { code: error.code ?? error.name }));
  process.exitCode = EXIT.refused;
});

try {
  const code = await main(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
} catch (error) {
  if (error instanceof InstallError || error instanceof KeyFileError || error instanceof PasswordError || error instanceof RegistryFileError || error instanceof DictionaryFileError || error instanceof DictionaryBuildError || error instanceof SlovarFormatError) {
    printError(error.message);
    process.exitCode = EXIT.refused;
  } else if (error instanceof ClientError) {
    // Автор из cli.json отозван или его роли действие не разрешено — подсказка про --as (research R9).
    const hint = authorFromCliJson && (error.code === "forbidden" || error.code === "member_revoked") ? ` ${message("cli_as_hint")}` : "";
    printError(error.message + hint);
    process.exitCode =
      error.code === "service_unavailable" ? EXIT.unavailable : error.code === "api_version_incompatible" ? EXIT.apiVersion : EXIT.refused;
  } else if (typeof (error as { code?: unknown }).code === "string" && (error as { code: string }).code.startsWith("ERR_PARSE_ARGS_")) {
    // Ошибки node:util parseArgs — по коду и имени флага, без английского текста (ревью, P2).
    const code = (error as { code: string }).code;
    const quoted = /'([^' ]+)/.exec((error as Error).message)?.[1] ?? "";
    printError(
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? message("cli_unknown_option", { option: quoted })
        : code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
          ? message("cli_unexpected_argument", { value: quoted })
          : message("cli_bad_option_value", { option: quoted }),
    );
    process.exitCode = EXIT.refused;
  } else {
    // Текст системных ошибок может быть английским — человеку показывается только код.
    const code = (error as { code?: unknown }).code;
    printError(message("cli_unexpected", { code: typeof code === "string" ? code : error instanceof Error ? error.name : "?" }));
    process.exitCode = EXIT.refused;
  }
}
