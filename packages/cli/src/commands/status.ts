// aristotel status — роль, версии, путь к БД, доступность службы (contracts/cli.md).
import { bankPath, ensureTlsKey, readAccessToken, readInstall } from "@aristotel/core";
import type { LocalState } from "@aristotel/protocol";
import { ApiClient } from "../client.ts";
import { PROGRAM_VERSION, message, tlsSpkiGroups, type GroupKeyInfo, type RegistryState, type StatusResponse, type VersionInfo } from "@aristotel/protocol";
import { RelayRegistry } from "@aristotel/relay";
import { serviceClient } from "../service-client.ts";
import { groupKeyStateName } from "./group-key.ts";
import { EXIT, printFields, printJson } from "../output.ts";

/** Ретранслятор: отпечаток TLS, номер Реестра, развилка — по файлам каталога данных. */
function relayStatus(dataDir: string, json: boolean): number {
  const install = readInstall(dataDir);
  const tls = ensureTlsKey(dataDir);
  const registry = new RelayRegistry(dataDir, install.relay?.group ?? "", tls.tlsSpki);
  const result = {
    role: install.role,
    programVersion: PROGRAM_VERSION,
    group: install.relay?.group ?? null,
    url: install.relay?.url ?? null,
    tlsSpki: tls.tlsSpki,
    registryNumber: registry.number() === 0 ? null : registry.number(),
    halted: registry.halted(),
  };
  if (json) printJson(result);
  else
    printFields([
      [message("label_role"), result.role],
      [message("label_program_version"), result.programVersion],
      [message("label_group_code"), result.group ?? "—"],
      [message("label_tls_spki"), `${result.tlsSpki} (${tlsSpkiGroups(result.tlsSpki)})`],
      [message("label_registry"), result.registryNumber === null ? message("cli_registry_none") : message("registry_number_status", { number: result.registryNumber })],
      [message("label_registry_halted"), result.halted ? message("cli_registry_halted") : "—"],
    ]);
  return EXIT.ok;
}

/** Станция: принята ли, открыт ли ключ, связь, отпечатки, Член Группы и роль — у локальной части. */
async function stationStatus(dataDir: string, json: boolean): Promise<number> {
  const install = readInstall(dataDir);
  let state: LocalState | undefined;
  try {
    state = await new ApiClient({ port: install.port, token: readAccessToken(dataDir) }).request<LocalState>("GET", "/local/state");
  } catch {
    state = undefined;
  }
  const result = { role: install.role, programVersion: PROGRAM_VERSION, port: install.port, localPart: state ?? null };
  if (json) printJson(result);
  else
    printFields([
      [message("label_role"), install.role],
      [message("label_program_version"), PROGRAM_VERSION],
      [message("label_local_part"), state === undefined ? message("local_part_down", { port: install.port }) : message("local_part_up", { port: install.port })],
      [message("label_member"), state?.memberLabel ?? "—"],
      [message("label_station_key"), state?.stationKeyFingerprint ?? (state?.unlocked === false ? message("station_key_locked") : "—")],
      [message("label_base_tls"), state?.baseTlsSpki === null || state?.baseTlsSpki === undefined ? "—" : tlsSpkiGroups(state.baseTlsSpki)],
      [
        message("label_relays_state"),
        state === undefined ? "—" : state.passage !== null ? state.passage : state.offlineSince !== null ? message("offline", { since: state.offlineSince }) : "—",
      ],
    ]);
  return state === undefined ? EXIT.unavailable : EXIT.ok;
}

export async function status(args: { dataDir: string; json: boolean; as: string | undefined }): Promise<number> {
  const install = readInstall(args.dataDir);
  if (install.role === "relay") return relayStatus(args.dataDir, args.json);
  if (install.role === "station") return await stationStatus(args.dataDir, args.json);
  let reachable = false;
  let service: VersionInfo | undefined;
  if (install.role === "base-station") {
    try {
      const res = await fetch(`http://127.0.0.1:${install.port}/api/version`);
      service = (await res.json()) as VersionInfo;
      reachable = res.ok;
    } catch {
      reachable = false;
    }
  }
  // Ключ Группы (фича 003): отпечаток и состояние — если служба отвечает и автор известен.
  let groupKey: GroupKeyInfo | undefined;
  let registryState: RegistryState | undefined;
  let station: StatusResponse | undefined;
  if (reachable) {
    // Автор — --as или Член Группы из cli.json, как у остальных команд (research R9 фичи 002).
    const client = serviceClient(args.dataDir, args.as);
    groupKey = await client.request<GroupKeyInfo>("GET", "/api/group-key").catch(() => undefined);
    registryState = await client.request<RegistryState>("GET", "/api/registry").catch(() => undefined);
    // Отпечаток TLS, Проходы и число Станций — API сопровождения (фича 004, APP-34).
    station = await client.request<StatusResponse>("GET", "/api/status").catch(() => undefined);
  }
  const result = {
    role: install.role,
    programVersion: PROGRAM_VERSION,
    apiVersions: install.apiVersions,
    bank: install.role === "base-station" ? bankPath(args.dataDir) : null,
    port: install.port,
    serviceReachable: reachable,
    serviceApiVersions: service?.apiVersions ?? null,
    groupKey: groupKey === undefined ? null : { keyFingerprint: groupKey.keyFingerprint, state: groupKey.state },
    registry: registryState === undefined ? null : { number: registryState.current?.number ?? null, halted: registryState.halted },
    tlsSpki: station?.tlsSpki ?? null,
    relays: station?.relays ?? null,
    activeStations: station?.activeStations ?? null,
  };
  if (args.json) printJson(result);
  else
    printFields([
      [message("label_role"), result.role],
      [message("label_program_version"), result.programVersion],
      [message("label_api_versions"), result.apiVersions.join(", ")],
      [message("label_bank_file"), result.bank ?? "—"],
      [
        message("label_service"),
        install.role !== "base-station"
          ? message("role_not_available", { role: install.role })
          : reachable
            ? message("service_reachable", { port: result.port })
            : message("service_unreachable"),
      ],
      [
        message("label_group_key"),
        groupKey === undefined ? "—" : `${groupKey.keyFingerprint} (${groupKeyStateName(groupKey.state)})`,
      ],
      [
        message("label_registry"),
        registryState === undefined
          ? "—"
          : (registryState.current === null ? message("cli_registry_none") : message("registry_number_status", { number: registryState.current.number })) +
            (registryState.halted ? ` — ${message("cli_registry_halted")}` : ""),
      ],
      [message("label_tls_spki"), station === undefined ? "—" : `${station.tlsSpki} (${tlsSpkiGroups(station.tlsSpki)})`],
      [
        message("label_relays_state"),
        station === undefined || station.relays.length === 0
          ? "—"
          : station.relays
              .map((r) => `${r.url} — ${r.connected ? message("relay_connected", { since: r.since ?? "" }) : message("relay_disconnected")}`)
              .join("\n" + " ".repeat(2)),
      ],
      [message("label_active_stations"), station === undefined ? "—" : String(station.activeStations)],
    ]);
  return reachable || install.role !== "base-station" ? EXIT.ok : EXIT.unavailable;
}
