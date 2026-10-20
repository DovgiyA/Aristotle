// Вид «Станции» — только Старшим (VIEW-47): Член Группы, отпечаток ключа, состояние «действует»,
// «только удаление» со сроком, «отозвана», последний сеанс; отзыв и сдача — без пароля (STATION-12,
// STATION-17, STATION-20). Рабочие копии и перечень утраченного — фичи 006, 009.
import type { ReactNode } from "react";
import type { Role, StationView } from "@aristotel/protocol/browser";
import { h } from "../h.ts";
import { t } from "../strings.ts";
import { actionsFor } from "../model/actions.ts";
import { Button, Table } from "./common.ts";

export interface StationsProps {
  role: Role;
  stations: StationView[];
  onRevoke?: (station: StationView, reason: "revoked" | "handover") => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Состояние Станции; у «только удаление» — оставшийся срок в днях и дата конца (US5/AC6, VIEW-47). */
export function stationStateText(station: Pick<StationView, "view" | "deleteOnlyUntil">, now: number = Date.now()): string {
  if (station.view === "delete-only") {
    const until = station.deleteOnlyUntil ?? "";
    const days = Math.max(0, Math.ceil((Date.parse(until) - now) / DAY_MS));
    return t("ui.stations.view.delete-only", { days, until });
  }
  return t(station.view === "active" ? "ui.stations.view.active" : "ui.stations.view.revoked");
}

export function StationsView(props: StationsProps): ReactNode {
  const can = actionsFor(props.role).stations;
  if (!can.view) return null;
  const rows = props.stations.map((s) => [
    s.memberLabel,
    h("code", null, s.keyFingerprint),
    stationStateText(s),
    s.lastSession === null ? "—" : s.lastSession.startedAt,
    s.state === "active" && can.revoke
      ? h(
          "span",
          null,
          Button({ label: t("ui.stations.revoke"), name: "station.revoke", kind: "danger", onClick: () => props.onRevoke?.(s, "revoked") }),
          Button({ label: t("ui.stations.handover"), name: "station.handover", onClick: () => props.onRevoke?.(s, "handover") }),
        )
      : null,
  ]);
  return h(
    "section",
    { "data-view": "stations" },
    h("h2", null, t("ui.nav.stations")),
    Table({ columns: [t("ui.stations.member"), t("ui.stations.fingerprint"), t("ui.stations.state"), t("ui.stations.last_session"), ""], rows }),
  );
}
