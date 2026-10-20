// aristotel material — Материалы на Станции (contracts/cli.md фичи 006): регистрация с Заверением,
// повторное Заверение, очередь доставки, список, показ, вид, удаление. CLI на Станции действует через
// сеанс локальной части (APP-08); подтверждение присутствия для выпуска образа — паролем (STATION-12).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { kindChangeAction, message, parseAttestationFile, type BankRecord, type MaterialView } from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { EXIT, printError, printFields, printJson, printTable } from "../output.ts";

export interface MaterialArgs {
  dataDir: string;
  json: boolean;
  action: string | undefined;
  value: string | undefined;
  value2: string | undefined;
  case: string | undefined;
  path: string | undefined;
  kind: string | undefined;
  attestation: string | undefined;
  /** material deliver <id> --file: файл Материала, зарегистрированного на другой Станции. */
  file: string | undefined;
  station: string | undefined;
  reason: string | undefined;
  deleted: boolean;
  attestations: boolean;
  wait: boolean;
}

interface QueueItem {
  id: string;
  size: number;
  received: number;
  state: "waiting" | "sending" | "done" | "rejected";
  error: string | null;
}

const view = (rec: BankRecord) => rec.view as unknown as MaterialView;

function deliveryText(v: MaterialView): string {
  if (v.deleted !== null) return message("material_deleted");
  return message(v.delivery === "delivered" ? "material_delivered" : "material_not_delivered");
}

function printMaterial(rec: BankRecord, withAttestations: boolean): void {
  const v = view(rec);
  printFields([
    [message("label_id"), rec.id],
    [message("label_material_path"), String(rec.fields["path"])],
    [message("label_case_id"), String(rec.fields["case"] ?? rec.fields["document"] ?? "—")],
    ["SHA-256", String(rec.fields["sha256"])],
    [message("label_material_size"), String(rec.fields["size"])],
    [message("label_material_kind"), rec.fields["kind"] === null ? message("material_kind_none") : String(rec.fields["kind"])],
    [message("label_material_delivery"), deliveryText(v)],
    [message("label_secret"), message(rec.secret ? "value_yes" : "value_no")],
    [message("label_version"), String(rec.version)],
  ]);
  if (withAttestations) {
    printTable(
      ["n", message("column_station"), message("column_at"), message("column_material_mark")],
      v.attestations.map((a) => [String(a.n) + (a.current ? " *" : ""), a.station, a.at, a.mark === null ? "—" : message(a.mark === "station_revoked" ? "material_mark_station_revoked" : "material_mark_station_unknown")]),
    );
  }
}

function usage(): number {
  printError(message("cli_material_usage"));
  return EXIT.refused;
}

export async function material(args: MaterialArgs): Promise<number> {
  const api = serviceClient(args.dataDir, undefined);
  switch (args.action) {
    case "register":
    case "reattest": {
      if (args.value === undefined || args.case === undefined) return usage();
      const body: Record<string, unknown> = { file: resolve(args.value), case: args.case };
      if (args.path !== undefined) body["path"] = args.path;
      if (args.kind !== undefined) body["kind"] = args.kind;
      if (args.action === "reattest") {
        if (args.attestation === undefined) return usage();
        body["attestation"] = parseAttestationFile(readFileSync(args.attestation, "utf8"));
      }
      const res = await api.request<{ id: string; sha256: string; size: string; record: BankRecord | null }>("POST", `/local/materials/${args.action}`, body);
      if (args.json) {
        printJson(res);
        return EXIT.ok;
      }
      printFields([
        [message("label_id"), res.id],
        ["SHA-256", res.sha256],
        [message("label_material_size"), res.size],
        [message("label_material_kind"), args.kind ?? message("material_kind_none")],
        [message("label_material_delivery"), res.record === null ? message("material_offline_registered") : message("material_not_delivered")],
      ]);
      return EXIT.ok;
    }
    case "status": {
      let items = (await api.request<{ items: QueueItem[] }>("GET", "/local/materials/queue")).items;
      while (args.wait && items.some((i) => i.state === "waiting" || i.state === "sending")) {
        await new Promise((r) => setTimeout(r, 500));
        items = (await api.request<{ items: QueueItem[] }>("GET", "/local/materials/queue")).items;
      }
      if (args.json) printJson(items);
      else printTable([message("label_id"), message("column_material_received"), message("label_material_delivery")], items.map((i) => [i.id, `${i.received} / ${i.size}`, message(`material_queue_${i.state}`) + (i.error === null ? "" : ` (${i.error})`)]));
      return items.some((i) => i.state === "rejected") ? EXIT.refused : EXIT.ok;
    }
    case "deliver": {
      if (args.value === undefined) return usage();
      // С --file — Материал, зарегистрированный на другой Станции (FR-008a): копия, сверка, очередь.
      if (args.file !== undefined) await api.request("POST", `/local/materials/${encodeURIComponent(args.value)}/attach`, { file: resolve(args.file) });
      else await api.request("POST", `/local/materials/${encodeURIComponent(args.value)}/deliver`, {});
      return EXIT.ok;
    }
    case "list": {
      const path = args.station !== undefined ? `/api/stations/${encodeURIComponent(args.station)}/materials` : args.case !== undefined ? `/api/materials?case=${encodeURIComponent(args.case)}${args.deleted ? "&deleted=include" : ""}` : undefined;
      if (path === undefined) return usage();
      const { items } = await api.request<{ items: BankRecord[] }>("GET", path);
      if (args.json) printJson(items);
      else
        printTable(
          [message("label_id"), message("label_material_path"), message("label_material_kind"), message("label_material_delivery"), message("label_secret")],
          items.map((r) => [r.id, String(r.fields["path"]), r.fields["kind"] === null ? message("material_kind_none") : String(r.fields["kind"]), deliveryText(view(r)), message(r.secret ? "value_yes" : "value_no")]),
        );
      return EXIT.ok;
    }
    case "show": {
      if (args.value === undefined) return usage();
      const rec = await api.request<BankRecord>("GET", `/api/materials/${encodeURIComponent(args.value)}`);
      if (args.json) printJson(rec);
      else printMaterial(rec, args.attestations);
      return EXIT.ok;
    }
    case "kind": {
      if (args.value === undefined || args.value2 === undefined) return usage();
      const current = await api.request<BankRecord>("GET", `/api/materials/${encodeURIComponent(args.value)}`);
      const owner = typeof current.fields["case"] === "string" ? "case" : "document";
      const change = kindChangeAction((current.fields["kind"] as string | null) ?? null, args.value2, owner);
      // Выпуск образа или логической копии — маршрут release с паролем (STATION-12); прочее — /kind.
      const suffix = "action" in change && change.action === "material.kind.release" ? "kind/release" : "kind";
      const rec = await api.request<BankRecord & { warning?: string }>("POST", `/api/materials/${encodeURIComponent(args.value)}/${suffix}`, { expectedVersion: current.version, kind: args.value2 });
      if (args.json) printJson(rec);
      else {
        printMaterial(rec, false);
        if (rec.warning !== undefined) printError(message("material_starts_leaving"));
      }
      return EXIT.ok;
    }
    case "delete": {
      if (args.value === undefined || args.reason === undefined) return usage();
      const current = await api.request<BankRecord>("GET", `/api/materials/${encodeURIComponent(args.value)}`);
      const rec = await api.request<BankRecord>("POST", `/api/materials/${encodeURIComponent(args.value)}/delete`, { expectedVersion: current.version, reason: args.reason });
      if (args.json) printJson(rec);
      else printMaterial(rec, false);
      return EXIT.ok;
    }
    default:
      return usage();
  }
}
