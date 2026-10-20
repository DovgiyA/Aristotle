// aristotel tls show|renew — отпечаток TLS-ключа Опорной станции или Ретранслятора и перевыпуск
// сертификата на том же ключе (RELAY-16, STATION-40; research R2 фичи 004; contracts/cli.md).
import { ensureTlsKey, readInstall, renewTlsCertificate, InstallError } from "@aristotel/core";
import { message, tlsSpkiGroups } from "@aristotel/protocol";
import { EXIT, printError, printFields, printJson } from "../output.ts";

export async function tls(args: { dataDir: string; json: boolean; action: string | undefined }): Promise<number> {
  const install = readInstall(args.dataDir);
  if (install.role === "station") throw new InstallError("cli_not_for_role", { role: install.role });
  let material;
  if (args.action === "show") material = ensureTlsKey(args.dataDir);
  else if (args.action === "renew") material = renewTlsCertificate(args.dataDir);
  else {
    printError(message("cli_tls_action"));
    return EXIT.refused;
  }
  const result = { tlsSpki: material.tlsSpki, groups: tlsSpkiGroups(material.tlsSpki), renewed: args.action === "renew" };
  if (args.json) printJson(result);
  else
    printFields([
      [message("label_tls_spki"), result.tlsSpki],
      [message("label_tls_groups"), result.groups],
    ]);
  return EXIT.ok;
}
