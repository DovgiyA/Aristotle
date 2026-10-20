// aristotel record get <id> / record history <id> — чтение Записи и её истории (APP-08; contracts/cli.md);
// record secret mark|unmark <id> — метка Секрет (ROLE-17, ROLE-18; contracts/cli.md фичи 002).
// record create --type <тип> --fields <JSON> — Запись модели данных (фича 005): Кейс получает Номер.
import { message, type BankRecord, type HistoryItem } from "@aristotel/protocol";
import type { ApiClient } from "../client.ts";
import { serviceClient } from "../service-client.ts";
import { EXIT, printError, printFields, printJson, printTable } from "../output.ts";

export interface RecordArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  action: string | undefined;
  id: string | undefined;
  /** Для record secret: mark|unmark и Идентификатор. */
  secretAction?: string | undefined;
  secretId?: string | undefined;
  expectedVersion?: string | undefined;
  type?: string | undefined;
  fields?: string | undefined;
}

function client(args: RecordArgs): ApiClient {
  return serviceClient(args.dataDir, args.as);
}

const show = (value: unknown): string => (value === null || value === undefined ? "—" : JSON.stringify(value));

function printRecord(rec: BankRecord): void {
  printFields([
    [message("label_id"), rec.id],
    [message("label_type"), rec.type],
    [message("label_version"), String(rec.version)],
    [message("label_secret"), message(rec.secret ? "value_yes" : "value_no")],
    ...(rec.type === "case" ? ([[message("label_case_number"), String(rec.fields["number"])]] as [string, string][]) : []),
    [message("label_fields"), JSON.stringify(rec.fields)],
    [message("label_created"), `${rec.createdAt} (${rec.createdBy})`],
    [message("label_updated"), `${rec.updatedAt} (${rec.updatedBy})`],
  ]);
}

async function secret(args: RecordArgs): Promise<number> {
  if ((args.secretAction !== "mark" && args.secretAction !== "unmark") || args.secretId === undefined) {
    printError(message("cli_record_usage"));
    return EXIT.refused;
  }
  const expectedVersion = Number(args.expectedVersion);
  if (args.expectedVersion === undefined || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    printError(message("cli_bad_expected_version", { value: args.expectedVersion ?? "" }));
    return EXIT.refused;
  }
  const rec = await client(args).request<BankRecord>(
    "POST",
    `/api/records/${encodeURIComponent(args.secretId)}/secret/${args.secretAction}`,
    { expectedVersion },
  );
  if (args.json) printJson(rec);
  else printRecord(rec);
  return EXIT.ok;
}

async function create(args: RecordArgs): Promise<number> {
  let fields: unknown;
  try {
    fields = JSON.parse(args.fields ?? "{}");
  } catch {
    printError(message("cli_record_fields_json"));
    return EXIT.refused;
  }
  if (args.type === undefined || typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    printError(message("cli_record_create_usage"));
    return EXIT.refused;
  }
  const rec = await client(args).request<BankRecord>("POST", "/api/records", { type: args.type, fields });
  if (args.json) printJson(rec);
  else printRecord(rec);
  return EXIT.ok;
}

export async function record(args: RecordArgs): Promise<number> {
  if (args.action === "secret") return secret(args);
  if (args.action === "create") return create(args);
  if (args.action !== "get" && args.action !== "history") {
    printError(message("cli_record_usage"));
    return EXIT.refused;
  }
  if (args.id === undefined) {
    printError(message("cli_record_id_missing"));
    return EXIT.refused;
  }
  const api = client(args);
  const path = `/api/records/${encodeURIComponent(args.id)}`;
  if (args.action === "get") {
    const rec = await api.request<BankRecord>("GET", path);
    if (args.json) printJson(rec);
    else printRecord(rec);
    return EXIT.ok;
  }
  const { items } = await api.request<{ items: HistoryItem[] }>("GET", `${path}/history`);
  if (args.json) printJson(items);
  else
    printTable(
      ["seq", ...(["column_version", "column_field", "column_before", "column_after", "column_actor", "column_at"] as const).map((c) => message(c))],
      // Наблюдателю seq строк истории не приходит (VIEW-59) — номер строки по порядку.
      items.map((i, n) => [i.seq === null ? String(n + 1) : String(i.seq), String(i.version), i.field, show(i.before), show(i.after), i.authorId, i.at]),
    );
  return EXIT.ok;
}
