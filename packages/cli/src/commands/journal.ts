// aristotel journal — журнал с фильтрами, таблицей или JSON (APP-08, INBOX-32; contracts/cli.md).
// Наблюдателю seq не приходит: в таблице — номер строки, страницы — по --cursor (VIEW-59).
import { message, type JournalResponse } from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { EXIT, printError, printJson, printTable } from "../output.ts";

export interface JournalArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  member: string | undefined;
  record: string | undefined;
  /** Кейс: действия по нему и по Записям, отнесённым к нему (фича 005; INBOX-32). */
  case?: string | undefined;
  action: string | undefined;
  limit: string | undefined;
  after: string | undefined;
  /** Непрозрачный курсор из прошлого вывода (VIEW-59). */
  cursor: string | undefined;
  /** Обойти все страницы, а не только первую. */
  all: boolean;
}

export async function journal(args: JournalArgs): Promise<number> {
  const query = new URLSearchParams();
  if (args.member !== undefined) query.set("member", args.member);
  if (args.record !== undefined) query.set("record", args.record);
  if (args.case !== undefined) query.set("case", args.case);
  if (args.action !== undefined) query.set("action", args.action);
  if (args.limit !== undefined) {
    if (!/^\d+$/.test(args.limit)) {
      printError(message("cli_bad_limit", { value: args.limit }));
      return EXIT.refused;
    }
    query.set("limit", args.limit);
  }
  if (args.after !== undefined && !/^\d+$/.test(args.after)) {
    printError(message("cli_bad_after", { value: args.after }));
    return EXIT.refused;
  }
  const api = serviceClient(args.dataDir, args.as);
  // Страницы журнала: без --all — одна, с курсором продолжения в stderr (stdout остаётся таблицей
  // или JSON-массивом); с --all — все: по next, а у Наблюдателя, которому seq не приходит, — по
  // непрозрачному cursor (INBOX-32, VIEW-59; ревью, P2).
  const items: JournalResponse["items"] = [];
  if (args.after !== undefined) query.set("after", args.after);
  if (args.cursor !== undefined) query.set("cursor", args.cursor);
  let page: JournalResponse;
  do {
    page = await api.request<JournalResponse>("GET", `/api/journal?${query.toString()}`);
    items.push(...page.items);
    query.delete("after");
    query.delete("cursor");
    if (page.next !== null) query.set("after", String(page.next));
    else if (page.cursor !== null) query.set("cursor", page.cursor);
  } while (args.all && page.cursor !== null);
  if (args.json) printJson(items);
  else
    printTable(
      ["seq", message("column_time"), message("column_actor"), message("column_action"), message("column_subject")],
      items.map((i, n) => [i.seq === null ? String(n + 1) : String(i.seq), i.at, i.actorLabel, i.action, `${i.subjectType} ${i.subjectId}`]),
    );
  if (!args.all && page.next !== null) process.stderr.write(message("cli_journal_more", { after: page.next }) + "\n");
  else if (!args.all && page.cursor !== null) process.stderr.write(message("cli_journal_more_cursor", { cursor: page.cursor }) + "\n");
  return EXIT.ok;
}
