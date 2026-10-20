// aristotel group-key — открытые Ключи Группы, отпечаток ключа подписи и состояние
// (GET /api/group-key; NET-41, NET-42, NET-53; contracts/cli.md фичи 003).
import { message, type GroupKeyInfo } from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { EXIT, printFields, printJson } from "../output.ts";

export const groupKeyStateName = (state: GroupKeyInfo["state"]): string =>
  message(state === "available" ? "group_key_state_available" : "group_key_state_unavailable");

export async function groupKey(args: { dataDir: string; json: boolean; as: string | undefined }): Promise<number> {
  const info = await serviceClient(args.dataDir, args.as).request<GroupKeyInfo>("GET", "/api/group-key");
  if (args.json) printJson(info);
  else
    printFields([
      [message("label_signing_key"), info.signingKey],
      [message("label_encryption_key"), info.encryptionKey],
      [message("label_key_fingerprint"), info.keyFingerprint],
      [message("label_state"), groupKeyStateName(info.state)],
      [message("label_member_created"), info.createdAt],
    ]);
  return EXIT.ok;
}
