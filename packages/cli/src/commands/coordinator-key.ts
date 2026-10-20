// aristotel coordinator-key create|show — без службы: файл ключа на носителе Старшего (NET-14);
// register|withdraw|list — через службу: привязка ключа к Старшему с доказательством владения
// (FR-016; contracts/cli.md фичи 003; research R6, R7).
import { readInstall } from "@aristotel/core";
import { coordinatorKeyProofMessage, keyFingerprint, message, type CoordinatorKeyItem, type CoordinatorKeysResponse } from "@aristotel/protocol";
import { cliMember } from "../cli-member.ts";
import { readStationState } from "@aristotel/station";
import { serviceClient } from "../service-client.ts";
import { checkKeyFileTarget, createKeyFile, readKeyFile } from "../key-file.ts";
import { readPassword } from "../password.ts";
import { EXIT, printError, printFields, printJson, printTable } from "../output.ts";

export interface CoordinatorKeyArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  action: string | undefined;
  path: string | undefined;
  out: string | undefined;
  passwordFile: string | undefined;
}

function printKey(json: boolean, publicKey: string): void {
  const result = { publicKey, keyFingerprint: keyFingerprint(publicKey) };
  if (json) printJson(result);
  else
    printFields([
      [message("label_public_key"), result.publicKey],
      [message("label_key_fingerprint"), result.keyFingerprint],
    ]);
}

const keyStateName = (state: CoordinatorKeyItem["state"]): string => message(`coordinator_key_state_${state}`);

function printItems(json: boolean, items: CoordinatorKeyItem[]): void {
  if (json) printJson(items);
  else
    printTable(
      [message("label_key_fingerprint"), message("column_senior"), message("label_state"), message("column_in_registry")],
      items.map((i) => [i.keyFingerprint, i.member.label, keyStateName(i.state), message(i.inCurrentRegistry ? "value_yes" : "value_no")]),
    );
}

export async function coordinatorKey(args: CoordinatorKeyArgs): Promise<number> {
  switch (args.action) {
    case "create": {
      if (args.out === undefined) {
        printError(message("cli_out_missing"));
        return EXIT.refused;
      }
      // Куда писать — до пароля и scrypt: отказ сразу, без секунды ожидания (T062).
      checkKeyFileTarget(args.out, args.dataDir);
      const password = await readPassword({ file: args.passwordFile, confirm: true });
      const { publicKey } = await createKeyFile(args.out, password, { dataDir: args.dataDir });
      printKey(args.json, publicKey);
      return EXIT.ok;
    }
    case "show": {
      if (args.path === undefined) {
        printError(message("cli_key_path_missing"));
        return EXIT.refused;
      }
      const key = await readKeyFile(args.path, await readPassword({ file: args.passwordFile, confirm: false }));
      printKey(args.json, key.publicKey);
      return EXIT.ok;
    }
    case "register": {
      if (args.path === undefined) {
        printError(message("cli_key_path_missing"));
        return EXIT.refused;
      }
      // На Станции владелец — её Член Группы, установка — Опорная станция из station.json (фича 004).
      const install = readInstall(args.dataDir);
      const station = install.role === "station" ? readStationState(args.dataDir) : undefined;
      const memberId = station?.memberId ?? cliMember(args.dataDir, args.as);
      if (memberId === undefined) {
        printError(message("cli_as_hint"));
        return EXIT.refused;
      }
      const key = await readKeyFile(args.path, await readPassword({ file: args.passwordFile, confirm: false }));
      const proofSig = key.sign(coordinatorKeyProofMessage(station?.baseInstallId ?? install.installId, memberId));
      const proof = Buffer.from(proofSig).toString("base64").replace(/=+$/, "");
      const item = await serviceClient(args.dataDir, args.as).request<CoordinatorKeyItem>("POST", "/api/coordinator-keys", {
        publicKey: key.publicKey,
        proof,
      });
      printItems(args.json, [item]);
      return EXIT.ok;
    }
    case "withdraw": {
      const item = await serviceClient(args.dataDir, args.as).request<CoordinatorKeyItem>("POST", "/api/coordinator-keys/withdraw", {});
      printItems(args.json, [item]);
      return EXIT.ok;
    }
    case "list": {
      const { items } = await serviceClient(args.dataDir, args.as).request<CoordinatorKeysResponse>("GET", "/api/coordinator-keys");
      printItems(args.json, items);
      return EXIT.ok;
    }
    default:
      printError(message("cli_unknown_command", { command: `coordinator-key ${args.action ?? ""}`.trim() }));
      return EXIT.refused;
  }
}
