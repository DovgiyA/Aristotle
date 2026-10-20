// aristotel member list|get|add|set|revoke — состав Группы через API (APP-08, ROLE-21, ROLE-36;
// contracts/cli.md фичи 002; research R9).
import { ROLES, message, type Member, type MessageCode, type Role } from "@aristotel/protocol";
import { ClientError, type ApiClient } from "../client.ts";
import { serviceClient } from "../service-client.ts";
import { EXIT, printError, printFields, printJson, printTable } from "../output.ts";

export interface MemberArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  action: string | undefined;
  id: string | undefined;
  label: string | undefined;
  role: string | undefined;
  expectedVersion: string | undefined;
}

function client(args: MemberArgs): ApiClient {
  return serviceClient(args.dataDir, args.as);
}

export const roleName = (role: string): string => message(`role_${role}` as MessageCode);
export const stateName = (state: string): string => message(`state_${state}` as MessageCode);

function printMember(member: Member): void {
  printFields([
    [message("label_id"), member.id],
    [message("label_member_label"), member.label],
    [message("label_role"), roleName(member.role)],
    [message("label_state"), stateName(member.state)],
    [message("label_version"), String(member.version)],
    [message("label_member_created"), member.createdAt],
  ]);
}

/**
 * Отказ version_conflict дополняется текущей записью Члена Группы из поля current ответа 409 —
 * чтобы повторить действие на текущей версии (contracts/cli.md: member set; research R7).
 */
async function withCurrentOnConflict<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ClientError) || error.code !== "version_conflict") throw error;
    const current = error.body["current"] as Member | undefined;
    if (current === undefined) throw error;
    const detail = message("cli_member_current", {
      version: current.version,
      role: roleName(current.role),
      label: current.label,
      state: stateName(current.state),
    });
    throw new ClientError(error.code, `${error.message} ${detail}`, error.status, error.body);
  }
}

function usage(): number {
  printError(message("cli_member_usage"));
  return EXIT.refused;
}

function parseVersion(value: string | undefined): number | undefined {
  const version = Number(value);
  if (value === undefined || !Number.isInteger(version) || version < 1) {
    printError(message("cli_bad_expected_version", { value: value ?? "" }));
    return undefined;
  }
  return version;
}

function parseRole(value: string | undefined): Role | undefined {
  if (value !== undefined && (ROLES as readonly string[]).includes(value)) return value as Role;
  printError(message("cli_bad_member_role", { value: value ?? "" }));
  return undefined;
}

export async function member(args: MemberArgs): Promise<number> {
  const api = client(args);
  switch (args.action) {
    case "list": {
      const { items } = await api.request<{ items: Member[] }>("GET", "/api/members");
      if (args.json) printJson(items);
      else
        printTable(
          [message("label_id"), message("column_label"), message("column_role"), message("column_state")],
          items.map((m) => [m.id, m.label, roleName(m.role), stateName(m.state)]),
        );
      return EXIT.ok;
    }
    case "get": {
      if (args.id === undefined) return usage();
      const found = await api.request<Member>("GET", `/api/members/${encodeURIComponent(args.id)}`);
      if (args.json) printJson(found);
      else printMember(found);
      return EXIT.ok;
    }
    case "add": {
      if (args.label === undefined) return usage();
      const role = parseRole(args.role);
      if (role === undefined) return EXIT.refused;
      const created = await api.request<Member>("POST", "/api/members", { label: args.label, role });
      if (args.json) printJson(created);
      else process.stdout.write(`${created.id}\n`);
      return EXIT.ok;
    }
    case "set": {
      if (args.id === undefined || (args.role === undefined && args.label === undefined)) return usage();
      const expectedVersion = parseVersion(args.expectedVersion);
      if (expectedVersion === undefined) return EXIT.refused;
      const body: { expectedVersion: number; role?: Role; label?: string } = { expectedVersion };
      if (args.role !== undefined) {
        const role = parseRole(args.role);
        if (role === undefined) return EXIT.refused;
        body.role = role;
      }
      if (args.label !== undefined) body.label = args.label;
      const id = args.id;
      const updated = await withCurrentOnConflict(() => api.request<Member>("PATCH", `/api/members/${encodeURIComponent(id)}`, body));
      if (args.json) printJson(updated);
      else printMember(updated);
      return EXIT.ok;
    }
    case "revoke": {
      if (args.id === undefined) return usage();
      const expectedVersion = parseVersion(args.expectedVersion);
      if (expectedVersion === undefined) return EXIT.refused;
      const id = args.id;
      const revoked = await withCurrentOnConflict(() =>
        api.request<Member>("POST", `/api/members/${encodeURIComponent(id)}/revoke`, { expectedVersion }),
      );
      if (args.json) printJson(revoked);
      else printMember(revoked);
      return EXIT.ok;
    }
    default:
      return usage();
  }
}
