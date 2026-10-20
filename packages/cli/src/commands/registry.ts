// aristotel registry relay-spki|sign — без службы: отпечаток TLS-сертификата Ретранслятора и подпись
// черновика файлом Ключа Координатора (NET-14, RELAY-16); draft|apply|show — через службу: черновик
// следующей версии, применение подписанной, чтение (FR-006 … FR-010; contracts/cli.md фичи 003).
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  REGISTRY_FORMAT,
  addSignature,
  bodySha256,
  keyFingerprint,
  message,
  parseRegistryBody,
  parseSignedDocument,
  serializeSignedDocument,
  spkiFingerprint,
  type RegistryBody,
  type RegistryCurrent,
  type RegistryState,
  type Relay,
  type SignedDocument,
} from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { readKeyFile } from "../key-file.ts";
import { readPassword } from "../password.ts";
import { EXIT, printError, printFields, printJson } from "../output.ts";

export interface RegistryArgs {
  dataDir: string;
  json: boolean;
  as: string | undefined;
  action: string | undefined;
  path: string | undefined;
  out: string | undefined;
  key: string | undefined;
  passwordFile: string | undefined;
  yes: boolean;
  code: string | undefined;
  addRelay: string[];
  removeRelay: string[];
  number: string | undefined;
  document: boolean;
}

/** Сводка версии для человека: номер, Код, Ретрансляторы, отпечатки Ключей Координатора. */
function summaryRows(body: RegistryBody): [string, string][] {
  const own = body.groups.find((g) => g.code === body.coordinatingGroup) ?? body.groups[0];
  const relays = (own?.relays ?? []).map((r) => `${r.url}  ${r.tlsSpki}`);
  return [
    [message("label_registry_number"), String(body.number)],
    [message("label_group_code"), own?.code ?? "—"],
    [message("label_coordinating_group"), body.coordinatingGroup],
    [message("label_relays"), relays.join("\n" + " ".repeat(2)) || "—"],
    [message("label_coordinator_keys"), body.coordinatorKeys.map(keyFingerprint).join("; ")],
  ];
}

function printCurrent(current: RegistryCurrent): void {
  printFields([
    ...summaryRows(current.body),
    [message("label_applied"), `${current.appliedAt} (${current.appliedBy.label})`],
    [message("label_signed_by"), current.signedBy.keyFingerprint],
  ]);
}

/** Чтение документа из файла: не JSON или не aristotel/reestr/v1 — отказ с понятным текстом. */
function readDocument(path: string): { doc: SignedDocument; body: RegistryBody } {
  try {
    const doc = parseSignedDocument(readFileSync(path, "utf8"), REGISTRY_FORMAT);
    return { doc, body: parseRegistryBody(doc.body) };
  } catch {
    throw new RegistryFileError(message("cli_registry_document_invalid", { path, format: REGISTRY_FORMAT }));
  }
}

export class RegistryFileError extends Error {}

function writeNew(path: string, text: string): void {
  try {
    writeFileSync(path, text, { flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new RegistryFileError(message("cli_file_exists", { path }));
    throw error;
  }
}

function parseRelay(value: string): Relay {
  const at = value.indexOf("=");
  if (at <= 0) throw new RegistryFileError(message("cli_bad_relay", { value }));
  return { url: value.slice(0, at), tlsSpki: value.slice(at + 1) };
}

async function confirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(message("cli_sign_confirm"), resolve));
  rl.close();
  return /^(да|д|y|yes)$/i.test(answer.trim());
}

export async function registry(args: RegistryArgs): Promise<number> {
  switch (args.action) {
    case "export": {
      // Подписанная версия как есть — для relay registry import (RELAY-19; contracts/cli.md фичи 004).
      if (args.out === undefined) {
        printError(message("cli_out_missing"));
        return EXIT.refused;
      }
      const client = serviceClient(args.dataDir, args.as);
      let number = args.number === undefined ? undefined : Number(args.number);
      if (number === undefined) number = (await client.request<RegistryState>("GET", "/api/registry")).current?.number;
      if (number === undefined || !Number.isInteger(number) || number < 1) {
        printError(message("cli_registry_none"));
        return EXIT.refused;
      }
      const doc = await client.request<SignedDocument>("GET", `/api/registry/versions/${number}`);
      writeNew(args.out, serializeSignedDocument(doc));
      if (args.json) printJson({ number, out: args.out });
      else printFields([[message("label_registry_number"), String(number)]]);
      return EXIT.ok;
    }
    case "relay-spki": {
      if (args.path === undefined) {
        printError(message("cli_cert_path_missing"));
        return EXIT.refused;
      }
      const tlsSpki = spkiFingerprint(readFileSync(args.path, "utf8"));
      if (args.json) printJson({ tlsSpki });
      else process.stdout.write(`${tlsSpki}\n`);
      return EXIT.ok;
    }
    case "sign": {
      if (args.path === undefined || args.key === undefined || args.out === undefined) {
        printError(message("cli_sign_args_missing"));
        return EXIT.refused;
      }
      const { doc, body } = readDocument(args.path);
      // При --json stdout — только JSON-результат, сводка для подтверждения — в stderr (T068).
      printFields(summaryRows(body), args.json ? process.stderr : process.stdout);
      if (!args.yes && !(await confirm())) {
        printError(message("cli_sign_not_confirmed"));
        return EXIT.refused;
      }
      const key = await readKeyFile(args.key, await readPassword({ file: args.passwordFile, confirm: false }));
      const signed = addSignature(doc, key.publicKey, key.sign);
      writeNew(args.out, serializeSignedDocument(signed));
      if (args.json) printJson({ number: body.number, bodySha256: bodySha256(doc.body), keyFingerprint: keyFingerprint(key.publicKey), out: args.out });
      else process.stdout.write(message("cli_signed", { fingerprint: keyFingerprint(key.publicKey), path: args.out }) + "\n");
      return EXIT.ok;
    }
    case "draft": {
      if (args.out === undefined) {
        printError(message("cli_out_missing"));
        return EXIT.refused;
      }
      const request: Record<string, unknown> = {};
      if (args.code !== undefined) request["code"] = args.code;
      if (args.addRelay.length > 0) request["addRelays"] = args.addRelay.map(parseRelay);
      if (args.removeRelay.length > 0) request["removeRelays"] = args.removeRelay;
      const doc = await serviceClient(args.dataDir, args.as).request<SignedDocument>("POST", "/api/registry/draft", request);
      writeNew(args.out, serializeSignedDocument(doc));
      if (args.json) printJson(doc);
      else printFields(summaryRows(parseRegistryBody(doc.body)));
      return EXIT.ok;
    }
    case "apply": {
      if (args.path === undefined) {
        printError(message("cli_registry_path_missing"));
        return EXIT.refused;
      }
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(args.path, "utf8"));
      } catch {
        throw new RegistryFileError(message("cli_registry_document_invalid", { path: args.path, format: REGISTRY_FORMAT }));
      }
      const current = await serviceClient(args.dataDir, args.as).request<RegistryCurrent>("POST", "/api/registry/versions", document);
      if (args.json) printJson(current);
      else printCurrent(current);
      return EXIT.ok;
    }
    case "show": {
      const client = serviceClient(args.dataDir, args.as);
      if (args.document || args.number !== undefined) {
        let number = args.number === undefined ? undefined : Number(args.number);
        if (number === undefined) {
          const state = await client.request<RegistryState>("GET", "/api/registry");
          if (state.current === null) {
            printError(message("cli_registry_none"));
            return EXIT.refused;
          }
          number = state.current.number;
        }
        if (!Number.isInteger(number) || number < 1) {
          printError(message("cli_bad_number", { value: args.number ?? "" }));
          return EXIT.refused;
        }
        const text = await client.requestText(`/api/registry/versions/${number}`);
        if (args.document) {
          process.stdout.write(text);
          return EXIT.ok;
        }
        const doc = parseSignedDocument(text, REGISTRY_FORMAT);
        const body = parseRegistryBody(doc.body);
        if (args.json) printJson({ number: body.number, bodySha256: bodySha256(doc.body), body, signedBy: doc.signatures.map((s) => keyFingerprint(s.key)) });
        else printFields(summaryRows(body));
        return EXIT.ok;
      }
      const state = await client.request<RegistryState>("GET", "/api/registry");
      if (args.json) printJson(state);
      else if (state.current === null) process.stdout.write(message("cli_registry_none") + "\n");
      else {
        printCurrent(state.current);
        if (state.halted) process.stdout.write(message("cli_registry_halted") + "\n");
      }
      return EXIT.ok;
    }
    default:
      printError(message("cli_unknown_command", { command: `registry ${args.action ?? ""}`.trim() }));
      return EXIT.refused;
  }
}
