// aristotel local propose|proposals|accept|reject|show — Местное расширение Группы (contracts/cli.md
// фичи 005; DICT-05, DICT-07, DICT-45). На Станции через сеанс.
import { readFileSync } from "node:fs";
import { message, type LocalProposalView } from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { EXIT, keyLabel, printError, printFields, printJson, printTable } from "../output.ts";

/**
 * Файл предложения — JSON-объект; нет файла, не JSON или не объект — причина с именем файла, а не
 * «непредвиденная ошибка» (contracts/cli.md; T215).
 */
function readPayload(path: string): Record<string, unknown> | undefined {
  let reason: string;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    reason = message("cli_local_payload_not_object");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") reason = message("slovar_file_missing");
    else if (error instanceof SyntaxError) reason = message("slovar_not_json");
    else throw error;
  }
  printError(message("slovar_file_invalid", { path, reason }));
  return undefined;
}

export interface LocalArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  action: string | undefined;
  value: string | undefined;
  payloadFile: string | undefined;
  state: string | undefined;
  reason: string | undefined;
}

/** Суть предложения — чтобы решать по списку без --json (T229): Код, значение, подпись поля, правило. */
function subjectOf(p: LocalProposalView, codeOf: (ref: string) => string): string {
  const pl = p.payload;
  const s = (k: string) => (typeof pl[k] === "string" ? (pl[k] as string) : "");
  switch (p.kind) {
    case "type":
      return s("code");
    case "enum_value":
      return `${codeOf(s("enum"))}.${s("code")}`;
    case "template_field":
      return [s("class"), s("subtype"), s("label")].filter((x) => x !== "").join(" · ");
    case "stop_list_entry":
      // Тип строки и элемент ужесточения — Кодом, а не Идентификатором (T253).
      // Вид строки — по-русски: значение и шаблон с одной записью различаются (T296).
      return "remove" in pl ? `${message("label_local_removed")} ${s("remove")}` : `${keyLabel("stop_kind", s("kind"))} ${codeOf(s("type"))} ${s("value")}`;
    case "override":
      return `${codeOf(s("element"))} ${keyLabel("override", s("property"))} ${keyLabel("override_value", String(pl["value"]))}`;
    default:
      return "—";
  }
}

function printProposal(p: LocalProposalView): void {
  printFields([
    [message("label_id"), p.id],
    [message("label_kind"), keyLabel("proposal_kind", p.kind)],
    [message("label_state"), keyLabel("proposal_state", p.state)],
    // Принятое удаление строки «Местного» называет удалённую строку, а не созданную (Clarifications).
    ["remove" in p.payload ? message("label_local_removed") : message("label_local_result"), p.resultId ?? "—"],
  ]);
}

export async function local(args: LocalArgs): Promise<number> {
  const client = () => serviceClient(args.dataDir, args.as);
  switch (args.action) {
    case "propose": {
      if (args.value === undefined || args.payloadFile === undefined) {
        printError(message("cli_local_usage"));
        return EXIT.refused;
      }
      const payload = readPayload(args.payloadFile);
      if (payload === undefined) return EXIT.refused;
      const p = await client().request<LocalProposalView>("POST", "/api/local-extension/proposals", { kind: args.value, payload });
      if (args.json) printJson(p);
      else printProposal(p);
      return EXIT.ok;
    }
    case "proposals": {
      const q = args.state === undefined ? "" : `?state=${encodeURIComponent(args.state)}`;
      const { items } = await client().request<{ items: LocalProposalView[] }>("GET", `/api/local-extension/proposals${q}`);
      if (args.json) printJson({ items });
      else {
        const elements = (await client().request<{ items: { id: string; code: string }[] }>("GET", "/api/dictionary/elements")).items;
        const codes = new Map(elements.map((e) => [e.id, e.code]));
        const codeOf = (ref: string) => codes.get(ref) ?? ref;
        printTable(
          [message("label_id"), message("label_kind"), message("label_local_subject"), message("label_state")],
          items.map((p) => [p.id, keyLabel("proposal_kind", p.kind), subjectOf(p, codeOf), keyLabel("proposal_state", p.state)]),
        );
      }
      return EXIT.ok;
    }
    case "accept":
    case "reject": {
      if (args.value === undefined) {
        printError(message("cli_local_usage"));
        return EXIT.refused;
      }
      if (args.action === "reject" && (args.reason === undefined || args.reason.trim() === "")) {
        printError(message("cli_local_reason_missing"));
        return EXIT.refused;
      }
      const body = args.action === "reject" ? { reason: args.reason } : {};
      const p = await client().request<LocalProposalView>("POST", `/api/local-extension/proposals/${encodeURIComponent(args.value)}/${args.action}`, body);
      if (args.json) printJson(p);
      else printProposal(p);
      return EXIT.ok;
    }
    case "show": {
      const view = await client().request<{
        types: { code: string; label: string; state: string; props: { format?: unknown; autoSecret?: unknown } }[];
        enumValues: { code: string; label: string; enum: string; enumCode: string | null; state: string }[];
        templateFields: { classId: string; classCode: string | null; subtypeCode: string | null; block: string; field: { label: string } }[];
        overrides: { element: string; elementCode: string | null; property: string; value: unknown }[];
        stopList: { id: string; typeCode: string | null; kind: string; value: string; note: string; dormant: boolean }[];
      }>("GET", "/api/local-extension");
      if (args.json) printJson(view);
      else {
        // Всё Местное расширение (DICT-03): типы, значения перечней, поля шаблона, ужесточения, «Местное».
        // Коды вместо Идентификаторов, состояние — поглощённое видно (DICT-23, T211; T229).
        const state = (s: string) => keyLabel("element_state", s);
        // Формат и автоматический Секрет местного типа; «не действует» у строки «Местного» (T254).
        printTable(
          [message("label_code"), message("label_label"), message("label_state"), message("label_local_format"), keyLabel("override", "autoSecret")],
          view.types.map((t) => [t.code, t.label, state(t.state), String(t.props.format ?? "—"), t.props.autoSecret === true ? keyLabel("override_value", "true") : "—"]),
        );
        printTable(
          [message("label_local_enum"), message("label_code"), message("label_label"), message("label_state")],
          view.enumValues.map((v) => [v.enumCode ?? v.enum, v.code, v.label, state(v.state)]),
        );
        printTable(
          [message("label_local_class"), message("label_local_subtype"), message("label_local_block"), message("label_label")],
          view.templateFields.map((f) => [f.classCode ?? f.classId, f.subtypeCode ?? "—", keyLabel("form_block", f.block), f.field.label]),
        );
        printTable(
          [message("label_local_element"), message("label_local_property"), message("label_value")],
          view.overrides.map((o) => [o.elementCode ?? o.element, keyLabel("override", o.property), keyLabel("override_value", String(o.value))]),
        );
        // Идентификатор строки — для предложения удаления stop_list_entry { remove } (Clarifications).
        printTable(
          [message("label_id"), message("label_local_type"), message("label_local_kind"), message("label_local_value"), message("label_local_note"), message("label_state")],
          view.stopList.map((e) => [e.id, e.typeCode ?? "—", keyLabel("stop_kind", e.kind), e.value, e.note, e.dormant ? message("label_local_dormant") : "—"]),
        );
      }
      return EXIT.ok;
    }
    default:
      printError(message("cli_local_usage"));
      return EXIT.refused;
  }
}
