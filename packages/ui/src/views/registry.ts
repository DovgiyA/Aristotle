// Вид «Реестр Сети» — все роли (ROLE-37): номер версии, своя запись, Ретрансляторы и связь, отпечатки
// Ключа Группы, Ключей Координатора, TLS Опорной станции и своего Ключа станции — восемью группами hex
// (NET-42, FR-019); Старшему — черновик и подпись файлом Ключа Координатора (NET-14).
import type { ReactNode } from "react";
import type { Role } from "@aristotel/protocol/browser";
import { h } from "../h.ts";
import { t } from "../strings.ts";
import { actionsFor } from "../model/actions.ts";
import { Form, Input, Table } from "./common.ts";
import type { SignInput } from "../model/registry-sign.ts";

export interface RegistryInfo {
  number: number;
  code: string;
  relays: { url: string; tlsSpki: string }[];
  coordinatorKeyFingerprints: string[];
}

export interface RegistryProps {
  role: Role;
  registry: RegistryInfo | null;
  groupKeyFingerprint: string | null;
  /** Отпечаток TLS Опорной станции восемью группами hex. */
  baseTlsGroups: string | null;
  stationKeyFingerprint: string | null;
  connected: Record<string, boolean>;
  /** Подпись черновика: два пароля и файл ключа — значения формы, не состояние (US4.9). */
  onSign?: (input: SignInput) => void;
}

/** base64 без «=» → первые 128 бит восемью группами hex (как NET-42) — без node:crypto. */
export function spkiGroups(tlsSpki: string): string {
  const raw = atob(tlsSpki.padEnd(Math.ceil(tlsSpki.length / 4) * 4, "="));
  const hex = [...raw].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return (hex.slice(0, 32).match(/.{4}/g) ?? []).join(" ");
}

export function RegistryView(props: RegistryProps): ReactNode {
  const can = actionsFor(props.role).registry;
  const fingerprints: [string, string | null][] = [
    [t("ui.registry.group_key"), props.groupKeyFingerprint],
    [t("ui.registry.base_tls"), props.baseTlsGroups],
    [t("ui.registry.station_key"), props.stationKeyFingerprint],
  ];
  return h(
    "section",
    { "data-view": "registry" },
    h("h2", null, t("ui.nav.registry")),
    props.registry === null
      ? h("p", null, t("ui.registry.none"))
      : h(
          "div",
          null,
          h("p", null, `${t("ui.registry.number")}: ${props.registry.number} · ${t("ui.registry.group")}: ${props.registry.code}`),
          h("h3", null, t("ui.registry.relays")),
          Table({
            columns: [t("ui.registry.url"), t("ui.registry.tls"), ""],
            rows: props.registry.relays.map((r) => [r.url, h("code", null, spkiGroups(r.tlsSpki)), t(props.connected[r.url] === true ? "ui.registry.connected" : "ui.registry.disconnected")]),
          }),
          h("h3", null, t("ui.registry.coordinator_keys")),
          h("ul", null, ...props.registry.coordinatorKeyFingerprints.map((f) => h("li", { key: f }, h("code", null, f)))),
        ),
    h("dl", null, ...fingerprints.flatMap(([label, value]) => [h("dt", { key: `${label}-t` }, label), h("dd", { key: `${label}-d` }, h("code", null, value ?? "—"))])),
    can.apply && props.registry !== null
      ? Form({
          name: "registry.apply",
          submit: t("ui.registry.sign"),
          onSubmit: (v, files) => {
            const file = files["keyFile"];
            if (file === undefined) return;
            void file.text().then((keyFileText) =>
              props.onSign?.({
                addRelay: v["addRelay"] ?? "",
                removeRelay: v["removeRelay"] ?? "",
                keyFileText,
                keyPassword: v["keyPassword"] ?? "",
                password: v["password"] ?? "",
              }),
            );
          },
          children: [
            Input({ label: t("ui.registry.add_relay"), name: "addRelay" }),
            Input({ label: t("ui.registry.remove_relay"), name: "removeRelay" }),
            Input({ label: t("ui.registry.key_file"), name: "keyFile", type: "file", required: true }),
            Input({ label: t("ui.registry.key_password"), name: "keyPassword", type: "password", required: true }),
            Input({ label: t("ui.registry.member_password"), name: "password", type: "password", required: true }),
          ],
        })
      : null,
  );
}
