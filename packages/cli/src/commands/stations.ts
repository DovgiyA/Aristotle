// aristotel stations — вид «Станции» на Станции Старшего: Член Группы, отпечаток ключа, состояние,
// последний сеанс; stations revoke <id> [--handover] — отзыв или сдача без пароля (contracts/cli.md;
// VIEW-47, STATION-17, STATION-20).
import { readInstall, InstallError } from "@aristotel/core";
import { message, type MessageCode, type StationView, type StationsResponse } from "@aristotel/protocol";
import { serviceClient } from "../service-client.ts";
import { EXIT, printError, printJson, printTable } from "../output.ts";

export interface StationsArgs {
  dataDir: string;
  json: boolean;
  action: string | undefined;
  id: string | undefined;
  handover: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Состояние как в интерфейсе; у «только удаление» — оставшийся срок в днях (US5/AC6, VIEW-47). */
function stateText(station: StationView, now: number = Date.now()): string {
  const until = station.deleteOnlyUntil ?? "";
  const days = Math.max(0, Math.ceil((Date.parse(until) - now) / DAY_MS));
  return message(`ui.stations.view.${station.view}` as MessageCode, { until, days });
}

function printStations(json: boolean, items: StationView[]): void {
  if (json) return printJson(items);
  printTable(
    [message("ui.stations.member"), message("ui.stations.fingerprint"), message("ui.stations.state"), message("ui.stations.last_session"), message("ui.stations.id")],
    items.map((s) => [s.memberLabel, s.keyFingerprint, stateText(s), s.lastSession?.startedAt ?? "—", s.id]),
  );
}

export async function stations(args: StationsArgs): Promise<number> {
  const install = readInstall(args.dataDir);
  if (install.role !== "station") throw new InstallError("cli_not_for_role", { role: install.role });
  const client = serviceClient(args.dataDir, undefined);
  if (args.action === undefined) {
    printStations(args.json, (await client.request<StationsResponse>("GET", "/api/stations")).items);
    return EXIT.ok;
  }
  if (args.action === "revoke" && args.id !== undefined) {
    const view = await client.request<StationView>("POST", `/api/stations/${args.id}/revoke`, { reason: args.handover ? "handover" : "revoked" });
    if (args.json) printJson(view);
    else printStations(false, [view]);
    return EXIT.ok;
  }
  printError(message("cli_stations_usage"));
  return EXIT.refused;
}
