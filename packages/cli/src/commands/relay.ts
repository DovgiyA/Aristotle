// aristotel relay registry import <файл> — первая версия Реестра на Ретранслятор при установке
// (RELAY-19; research R3 фичи 004; contracts/cli.md).
import { readFileSync } from "node:fs";
import { ensureTlsKey, readInstall, InstallError } from "@aristotel/core";
import { message, type MessageCode } from "@aristotel/protocol";
import { RelayRegistry, RelayRegistryError } from "@aristotel/relay";
import { EXIT, printError, printFields, printJson } from "../output.ts";

export async function relay(args: { dataDir: string; json: boolean; action: string | undefined; sub: string | undefined; path: string | undefined }): Promise<number> {
  const install = readInstall(args.dataDir);
  if (install.role !== "relay" || install.relay === undefined) throw new InstallError("cli_not_for_role", { role: install.role });
  if (args.action !== "registry" || args.sub !== "import" || args.path === undefined) {
    printError(message("cli_relay_usage"));
    return EXIT.refused;
  }
  const tls = ensureTlsKey(args.dataDir);
  const registry = new RelayRegistry(args.dataDir, install.relay.group, tls.tlsSpki);
  try {
    const number = registry.importFirst(readFileSync(args.path, "utf8"));
    if (args.json) printJson({ number });
    else printFields([[message("label_registry_number"), String(number)]]);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof RelayRegistryError) {
      printError(message(`relay_import_${error.reason}` as MessageCode));
      return EXIT.refused;
    }
    throw error;
  }
}
