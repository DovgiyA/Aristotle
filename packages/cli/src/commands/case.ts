// aristotel case show <id> — Кейс с Изделиями, подписью и отвеченностью обязательных полей
// (contracts/cli.md фичи 005; DATA-01, DATA-27). Как все команды Записей — на Станции через сеанс.
import { GENERAL_PART, message, type BankRecord } from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { EXIT, keyLabel, printError, printFields, printJson, printTable } from "../output.ts";

export interface CaseArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  action: string | undefined;
  id: string | undefined;
}

export interface CaseSummary {
  case: BankRecord;
  items: BankRecord[];
  label: string;
  answered: { complete: boolean; missing: string[] };
  missingSections: string[];
}

export async function caseCommand(args: CaseArgs): Promise<number> {
  if (args.action !== "show" || args.id === undefined) {
    printError(message("cli_case_usage"));
    return EXIT.refused;
  }
  const summary = await serviceClient(args.dataDir, args.as).request<CaseSummary>("GET", `/api/cases/${encodeURIComponent(args.id)}`);
  if (args.json) {
    printJson(summary);
    return EXIT.ok;
  }
  printFields([
    [message("label_case_number"), summary.label],
    [message("label_id"), summary.case.id],
    [message("label_case_status"), keyLabel("case_status", String(summary.case.fields["status"]))],
    [message("label_case_designation"), String(summary.case.fields["designation"] ?? "—")],
    // Неотвеченные поля общей части — Подписями Формуляра (DATA-14 … DATA-19), поля Изделий — как есть.
    [message("label_case_answered"), summary.answered.complete ? message("value_yes") : summary.answered.missing.map((f) => GENERAL_PART.find((g) => g.field === f)?.label ?? f).join(", ")],
  ]);
  if (summary.items.length > 0) {
    printTable([message("label_id"), message("label_label")], summary.items.map((i) => [i.id, String(i.view?.["label"] ?? "")]));
  }
  return EXIT.ok;
}
