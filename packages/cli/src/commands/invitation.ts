// aristotel invitation — на Опорной станции: issue --senior <id> [--out <файл>] по STATION-43 (APP-34);
// на Станции: issue <memberId> [--out], list, cancel <id> — через сеанс, выпуск с паролем (STATION-12,
// STATION-13, STATION-44; T056 фичи 004). Строка Приглашения печатается или пишется в файл один раз.
import { writeFileSync } from "node:fs";
import { readInstall, restrictToOwner, InstallError } from "@aristotel/core";
import { message, type InvitationView, type InvitationsResponse, type IssueInvitationResponse, type MessageCode } from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { EXIT, printError, printFields, printJson, printTable } from "../output.ts";

export interface InvitationArgs {
  dataDir: string;
  json: boolean;
  action: string | undefined;
  senior: string | undefined;
  out: string | undefined;
  /** На Станции: Член Группы для issue или Идентификатор Приглашения для cancel. */
  id?: string | undefined;
}

function printInvitations(json: boolean, items: InvitationView[]): void {
  if (json) printJson(items);
  else
    printTable(
      [message("column_invitation"), message("column_for"), message("column_until"), message("label_state")],
      items.map((i) => [i.id, i.memberLabel, i.expiresAt, message(`invitation_view_${i.view}` as MessageCode)]),
    );
}

function deliver(args: InvitationArgs, issued: IssueInvitationResponse): void {
  if (args.out !== undefined) {
    writeFileSync(args.out, `${issued.invitation}\n`, { mode: 0o600, flag: "wx" });
    restrictToOwner(args.out);
  }
  if (args.json) printJson({ id: issued.id, memberId: issued.memberId, expiresAt: issued.expiresAt, ...(args.out === undefined ? { invitation: issued.invitation } : { out: args.out }) });
  else {
    printFields([
      [message("label_invitation_for"), issued.memberId],
      [message("label_invitation_expires"), issued.expiresAt],
    ]);
    if (args.out === undefined) process.stdout.write(`${issued.invitation}\n`);
  }
}

export async function invitation(args: InvitationArgs): Promise<number> {
  const install = readInstall(args.dataDir);
  if (install.role === "base-station") {
    if (args.action !== "issue" || args.senior === undefined) {
      printError(message("cli_invitation_usage"));
      return EXIT.refused;
    }
    const issued = await serviceClient(args.dataDir, undefined).request<IssueInvitationResponse>("POST", "/api/invitations/senior", { memberId: args.senior });
    deliver(args, issued);
    return EXIT.ok;
  }
  if (install.role !== "station") throw new InstallError("cli_not_for_role", { role: install.role });
  const client = serviceClient(args.dataDir, undefined);
  switch (args.action) {
    case "issue": {
      if (args.id === undefined) break;
      deliver(args, await client.request<IssueInvitationResponse>("POST", "/api/invitations", { memberId: args.id }));
      return EXIT.ok;
    }
    case "list":
      printInvitations(args.json, (await client.request<InvitationsResponse>("GET", "/api/invitations")).items);
      return EXIT.ok;
    case "cancel": {
      if (args.id === undefined) break;
      printInvitations(args.json, [await client.request<InvitationView>("POST", `/api/invitations/${args.id}/cancel`, {})]);
      return EXIT.ok;
    }
  }
  printError(message("cli_invitation_station_usage"));
  return EXIT.refused;
}
