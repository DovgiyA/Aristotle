// aristotel dictionary build|sign — без службы: сборка версии Словаря Сети из исходника и подпись
// файлом Ключа Координатора (research R5 фичи 005; DICT-16, NET-14, NET-54); apply|show|export|
// elements|stop-lists — через службу: на Станции через сеанс, на Опорной станции через API
// сопровождения (APP-34; contracts/cli.md фичи 005).
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  SLOVAR_FORMAT,
  SLOVAR_MAX_BODY_BYTES,
  addSignature,
  bodySha256,
  keyFingerprint,
  message,
  parseSignedDocument,
  parseSlovarBody,
  parseStopListFile,
  serializeSignedDocument,
  SlovarFormatError,
  type DictElementView,
  type DictionaryCurrent,
  type DictionaryState,
  type MessageCode,
  type SignedDocument,
  type SlovarBody,
} from "@aristotel/protocol";
import { buildVersion, readDictionarySource } from "@aristotel/core";
import { serviceClient } from "../service-client.ts";
import { readKeyFile } from "../key-file.ts";
import { readPassword } from "../password.ts";
import { EXIT, keyLabel, printError, printFields, printJson, printTable } from "../output.ts";

export interface DictionaryArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  action: string | undefined;
  path: string | undefined;
  out: string | undefined;
  key: string | undefined;
  passwordFile: string | undefined;
  yes: boolean;
  source: string | undefined;
  previous: string | undefined;
  stopList: string[];
  number: string | undefined;
  kind: string | undefined;
  code: string | undefined;
}

export class DictionaryFileError extends Error {}

function writeNew(path: string, text: string): void {
  try {
    writeFileSync(path, text, { flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new DictionaryFileError(message("cli_file_exists", { path }));
    throw error;
  }
}

function readDocument(path: string): { doc: SignedDocument; body: SlovarBody } {
  try {
    const doc = parseSignedDocument(readFileSync(path, "utf8"), SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES });
    return { doc, body: parseSlovarBody(doc.body) };
  } catch {
    throw new DictionaryFileError(message("cli_dictionary_document_invalid", { path, format: SLOVAR_FORMAT }));
  }
}

function summaryRows(doc: SignedDocument, body: SlovarBody): [string, string][] {
  return [
    [message("label_dictionary_number"), String(body.number)],
    [message("label_dictionary_sha"), bodySha256(doc.body)],
    [message("label_dictionary_elements"), String(body.elements.length)],
    [message("label_dictionary_stop_lists"), body.stopLists.map((l) => `${l.code} ${l.rows.length}`).join("; ") || "—"],
  ];
}

/** Подписи счётчиков применения — locales/ru.json (конституция VIII); неизвестный ключ — как есть. */
const COUNTER_LABELS: Record<string, MessageCode> = {
  synonyms: "label_apply_synonyms",
  localTypesMerged: "label_apply_local_types_merged",
  localValuesMerged: "label_apply_local_values_merged",
  stopListRows: "label_apply_stop_list_rows",
  stopListGained: "label_apply_stop_list_gained",
  stopListLost: "label_apply_stop_list_lost",
  secretMarked: "label_apply_secret_marked",
};

/** Виды и состояния элементов Словаря — по-русски (конституция VIII); неизвестный ключ — как есть. */
const KIND_LABELS: Record<string, MessageCode> = {
  object_type: "label_element_kind_object_type",
  link_type: "label_element_kind_link_type",
  indicator_type: "label_element_kind_indicator_type",
  enum: "label_element_kind_enum",
  enum_value: "label_element_kind_enum_value",
};
const STATE_LABELS: Record<string, MessageCode> = {
  active: "label_element_state_active",
  deprecated: "label_element_state_deprecated",
  absorbed: "label_element_state_absorbed",
};
const labelOf = (labels: Record<string, MessageCode>, key: string): string => (labels[key] === undefined ? key : message(labels[key]));

/** Эффективные свойства элемента для таблицы: формат, опознание, автоматический Секрет, перечень значения. */
function elementProps(e: DictElementView, enumCode: Map<string, string>): string {
  const p = e.props;
  if (e.kind === "indicator_type") {
    return [
      String(p["format"] ?? ""),
      `${keyLabel("override", "identifying")} ${keyLabel("override_value", String(p["identifying"]))}`,
      ...(p["autoSecret"] === true ? [`${keyLabel("override", "autoSecret")} ${keyLabel("override_value", "true")}`] : []),
    ].join("; ");
  }
  if (e.kind === "enum_value") return enumCode.get(String(p["enum"])) ?? String(p["enum"]);
  return "—";
}

function counterLabel(key: string): string {
  const code = COUNTER_LABELS[key];
  return code === undefined ? key : message(code);
}

function printCurrent(current: DictionaryCurrent): void {
  printFields([
    [message("label_dictionary_number"), String(current.number)],
    [message("label_dictionary_sha"), current.bodySha256],
    [message("label_applied"), `${current.appliedAt} (${current.appliedBy.label})`],
    [message("label_signed_by"), current.signedBy.keyFingerprint],
    ...(current.applied === undefined
      ? []
      : [[message("label_dictionary_applied"), Object.entries(current.applied).map(([k, n]) => `${counterLabel(k)} ${n}`).join("; ")] as [string, string]]),
  ]);
}

async function confirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(message("cli_sign_confirm"), resolve));
  rl.close();
  return /^(да|д|y|yes)$/i.test(answer.trim());
}

export async function dictionary(args: DictionaryArgs): Promise<number> {
  switch (args.action) {
    case "build": {
      if (args.source === undefined || args.out === undefined) {
        printError(message("cli_dictionary_build_args"));
        return EXIT.refused;
      }
      // Испорченный --previous или файл списка — причина и код отказа, а не «непредвиденная ошибка» (T200).
      if (args.previous !== undefined) readDocument(args.previous);
      const previous = args.previous === undefined ? undefined : readFileSync(args.previous, "utf8");
      const stopListFiles = args.stopList.map((p) => {
        try {
          return parseStopListFile(readFileSync(p, "utf8"));
        } catch (error) {
          if (error instanceof SlovarFormatError) throw new DictionaryFileError(message("slovar_file_invalid", { path: p, reason: error.message }));
          // Нет файла --stop-list — тоже причина с именем файла (T214).
          if ((error as { code?: string }).code === "ENOENT") throw new DictionaryFileError(message("slovar_file_invalid", { path: p, reason: message("slovar_file_missing") }));
          throw error;
        }
      });
      const { doc, report } = buildVersion({ source: readDictionarySource(args.source), ...(previous === undefined ? {} : { previous }), stopListFiles });
      writeNew(args.out, serializeSignedDocument(doc));
      if (args.json) printJson({ ...report, out: args.out });
      else {
        printFields([
          [message("label_dictionary_number"), String(report.number)],
          [message("label_dictionary_elements"), Object.entries(report.elements).map(([k, n]) => `${labelOf(KIND_LABELS, k)} ${n}`).join("; ")],
          [message("label_dictionary_stop_lists"), report.stopLists.map((l) => `${l.code} ${l.rows}`).join("; ") || "—"],
          [message("label_dictionary_missing"), report.missingStopLists.join(", ") || "—"],
          [message("label_dictionary_carried"), report.carriedStopLists.join(", ") || "—"],
        ]);
      }
      return EXIT.ok;
    }
    case "sign": {
      if (args.path === undefined || args.key === undefined || args.out === undefined) {
        printError(message("cli_sign_args_missing"));
        return EXIT.refused;
      }
      const { doc, body } = readDocument(args.path);
      // Отпечаток ключа — в сводке до подтверждения (contracts/cli.md; T220): ключ раскрывается раньше.
      const key = await readKeyFile(args.key, await readPassword({ file: args.passwordFile, confirm: false }));
      printFields([...summaryRows(doc, body), [message("label_key_fingerprint"), keyFingerprint(key.publicKey)]], args.json ? process.stderr : process.stdout);
      if (!args.yes && !(await confirm())) {
        printError(message("cli_sign_not_confirmed"));
        return EXIT.refused;
      }
      const signed = addSignature(doc, key.publicKey, key.sign);
      writeNew(args.out, serializeSignedDocument(signed));
      if (args.json) printJson({ number: body.number, bodySha256: bodySha256(doc.body), keyFingerprint: keyFingerprint(key.publicKey), out: args.out });
      else process.stdout.write(message("cli_signed", { fingerprint: keyFingerprint(key.publicKey), path: args.out }) + "\n");
      return EXIT.ok;
    }
    case "apply": {
      if (args.path === undefined) {
        printError(message("cli_dictionary_path_missing"));
        return EXIT.refused;
      }
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(args.path, "utf8"));
      } catch {
        throw new DictionaryFileError(message("cli_dictionary_document_invalid", { path: args.path, format: SLOVAR_FORMAT }));
      }
      const current = await serviceClient(args.dataDir, args.as).request<DictionaryCurrent>("POST", "/api/dictionary/versions", document);
      if (args.json) printJson(current);
      else printCurrent(current);
      return EXIT.ok;
    }
    case "show": {
      const state = await serviceClient(args.dataDir, args.as).request<DictionaryState>("GET", "/api/dictionary");
      if (args.json) printJson(state);
      else if (state.current === null) process.stdout.write(message("cli_dictionary_none") + "\n");
      else printCurrent(state.current);
      return EXIT.ok;
    }
    case "export": {
      if (args.out === undefined) {
        printError(message("cli_out_missing"));
        return EXIT.refused;
      }
      // Номер — целое ≥ 1; иначе — неверный аргумент, а не «не применён» (T240).
      if (args.number !== undefined && !/^[1-9]\d{0,8}$/.test(args.number)) {
        printError(message("cli_bad_number", { value: args.number }));
        return EXIT.refused;
      }
      const client = serviceClient(args.dataDir, args.as);
      let number = args.number === undefined ? undefined : Number(args.number);
      if (number === undefined) number = (await client.request<DictionaryState>("GET", "/api/dictionary")).current?.number;
      if (number === undefined || !Number.isInteger(number) || number < 1) {
        printError(message("cli_dictionary_none"));
        return EXIT.refused;
      }
      writeNew(args.out, await client.requestText(`/api/dictionary/versions/${number}`));
      if (args.json) printJson({ number, out: args.out });
      else printFields([[message("label_dictionary_number"), String(number)]]);
      return EXIT.ok;
    }
    case "elements": {
      const q = new URLSearchParams();
      if (args.kind !== undefined) q.set("kind", args.kind);
      if (args.code !== undefined) q.set("code", args.code);
      const path = `/api/dictionary/elements${q.size > 0 ? `?${q}` : ""}`;
      const client = serviceClient(args.dataDir, args.as);
      const { items } = await client.request<{ items: DictElementView[] }>("GET", path);
      if (args.json) printJson({ items });
      else {
        // Вид — в единственном числе, уровень и эффективные свойства: ужесточения Группы видны
        // (contracts/cli.md, DICT-07; T254). Значение перечня — с Кодом перечня.
        const enums = items.some((e) => e.kind === "enum_value") ? (await client.request<{ items: DictElementView[] }>("GET", "/api/dictionary/elements?kind=enum")).items : [];
        const enumCode = new Map(enums.map((e) => [e.id, e.code]));
        printTable(
          [message("label_kind"), message("label_level"), message("label_code"), message("label_label"), message("label_state"), message("label_element_props")],
          items.map((e) => [keyLabel("element_one", e.kind), keyLabel("level", e.level), e.code, e.label, labelOf(STATE_LABELS, e.state), elementProps(e, enumCode)]),
        );
      }
      return EXIT.ok;
    }
    case "stop-lists": {
      const { items } = await serviceClient(args.dataDir, args.as).request<{ items: { code: string; label: string; rows: number; level: string }[] }>("GET", "/api/dictionary/stop-lists");
      if (args.json) printJson({ items });
      else printTable([message("label_code"), message("label_label"), message("label_rows")], items.map((l) => [l.code, l.label, String(l.rows)]));
      return EXIT.ok;
    }
    default:
      printError(message("cli_unknown_command", { command: `dictionary ${args.action ?? ""}`.trim() }));
      return EXIT.refused;
  }
}
