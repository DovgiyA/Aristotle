// aristotel form --class <код> [--subtype <код>] [--on-linux] — описание Формуляра (contracts/cli.md
// фичи 005; DATA-23). На Станции через сеанс.
import { message, type FormDescriptionView } from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { EXIT, keyLabel, printError, printJson, printTable } from "../output.ts";

export interface FormArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  class: string | undefined;
  subtype: string | undefined;
  onLinux: boolean;
}

export async function form(args: FormArgs): Promise<number> {
  if (args.class === undefined) {
    printError(message("cli_form_usage"));
    return EXIT.refused;
  }
  const q = new URLSearchParams({ class: args.class });
  if (args.subtype !== undefined) q.set("subtype", args.subtype);
  if (args.onLinux) q.set("onLinux", "true");
  const description = await serviceClient(args.dataDir, args.as).request<FormDescriptionView>("GET", `/api/form?${q}`);
  if (args.json) {
    printJson(description);
    return EXIT.ok;
  }
  // Общая часть Кейса — как в API (DATA-14 … DATA-19; T282).
  printTable(
    [message("label_label"), message("label_form_required"), message("label_form_source")],
    description.general.map((g) => [g.label, g.required ? message("value_yes") : message("value_no"), g.defaultSource === "auto" ? message("value_source_auto") : message("value_source_manual")]),
  );
  // Тип значения, «устарел» и «местное» — как в API (DATA-23, DICT-08, Edge Cases; T262).
  printTable(
    [message("label_form_block"), message("label_label"), message("label_form_required"), message("label_form_source"), message("label_local_format"), message("label_form_flags")],
    description.blocks.flatMap((b) =>
      b.fields.map((f) => [
        keyLabel("form_block", b.block),
        f.label,
        f.required ? message("value_yes") : message("value_no"),
        f.defaultSource === "auto" ? message("value_source_auto") : message("value_source_manual"),
        f.format ?? "—",
        [...(f.deprecated ? [message("label_form_deprecated")] : []), ...(f.local ? [message("label_form_local")] : [])].join(", ") || "—",
      ]),
    ),
  );
  return EXIT.ok;
}
