// aristotel station accept|unlock — Станция: приём по Приглашению (STATION-13, STATION-16) и открытие
// Ключа станции работающей локальной части (STATION-09; contracts/cli.md фичи 004). unlock — US3.
import { existsSync, readFileSync } from "node:fs";
import { readAccessToken, readInstall, InstallError, TlsMismatchError } from "@aristotel/core";
import { ApiClient } from "../client.ts";
import { keyFingerprint, message, tlsSpkiGroups, type MessageCode } from "@aristotel/protocol";
import { AcceptError, NoPassageError, UpdateRequiredError, acceptInvitation } from "@aristotel/station";
import { readPassword } from "../password.ts";
import { EXIT, printError, printFields, printJson } from "../output.ts";

export interface StationArgs {
  dataDir: string;
  json: boolean;
  action: string | undefined;
  value: string | undefined;
  passwordFile: string | undefined;
}

async function accept(args: StationArgs): Promise<number> {
  if (args.value === undefined) {
    printError(message("cli_station_accept_usage"));
    return EXIT.refused;
  }
  const invitation = existsSync(args.value) ? readFileSync(args.value, "utf8") : args.value;
  const password = await readPassword({ file: args.passwordFile, confirm: true, member: true });
  try {
    const result = await acceptInvitation({ dataDir: args.dataDir, invitation, password });
    if (args.json) printJson({ stationId: result.stationId, memberId: result.memberId, role: result.role, keyFingerprint: keyFingerprint(result.stationKey), baseTlsSpki: result.baseTlsSpki });
    else
      printFields([
        [message("label_station_accepted"), result.memberLabel],
        [message("label_role"), result.role],
        [message("label_station_key"), keyFingerprint(result.stationKey)],
        [message("label_base_tls"), tlsSpkiGroups(result.baseTlsSpki)],
      ]);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof TlsMismatchError) {
      printError(message("cli_tls_mismatch", { expected: tlsSpkiGroups(error.expected), seen: error.seen === "" ? "—" : tlsSpkiGroups(error.seen) }));
      return EXIT.refused;
    }
    if (error instanceof NoPassageError) {
      printError(message("cli_no_passage"));
      return EXIT.unavailable;
    }
    if (error instanceof UpdateRequiredError) {
      printError(message("cli_update_required", { supported: error.supported.join(", ") }));
      return EXIT.apiVersion;
    }
    if (error instanceof AcceptError) {
      let text: string;
      try {
        text = message(`accept_${error.code}` as MessageCode);
      } catch {
        text = message("accept_accept_failed");
      }
      printError(text);
      return EXIT.refused;
    }
    throw error;
  }
}

/** station unlock — открыть Ключ станции работающей локальной части с терминала (STATION-09). */
async function unlock(args: StationArgs): Promise<number> {
  const install = readInstall(args.dataDir);
  const password = await readPassword({ file: args.passwordFile, confirm: false, member: true });
  const client = new ApiClient({ port: install.port, token: readAccessToken(args.dataDir) });
  const state = await client.request<{ unlocked: boolean; memberLabel: string | null }>("POST", "/local/unlock", { password });
  if (args.json) printJson(state);
  else printFields([[message("label_station_unlocked"), state.memberLabel ?? "—"]]);
  return EXIT.ok;
}

export async function station(args: StationArgs): Promise<number> {
  const install = readInstall(args.dataDir);
  if (install.role !== "station") throw new InstallError("cli_not_for_role", { role: install.role });
  if (args.action === "accept") return await accept(args);
  if (args.action === "unlock") return await unlock(args);
  printError(message("cli_station_usage"));
  return EXIT.refused;
}
