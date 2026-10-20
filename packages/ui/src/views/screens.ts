// Экраны до работы с Банком: приём по Приглашению (STATION-16), вход и разблокировка паролем
// (STATION-09, STATION-11), подтверждение присутствия (STATION-12), состояние связи (STATION-03, APP-23).
import type { ReactNode } from "react";
import { h } from "../h.ts";
import { t } from "../strings.ts";
import { Button, ErrorLine, Field } from "./common.ts";

export function AcceptScreen(props: { error: string | null; onSubmit?: (invitation: string, password: string, again: string) => void }): ReactNode {
  const values = { invitation: "", password: "", again: "" };
  return h(
    "form",
    { "data-view": "accept", onSubmit: (e: { preventDefault: () => void }) => { e.preventDefault(); props.onSubmit?.(values.invitation, values.password, values.again); } },
    h("h1", null, t("ui.accept.title")),
    Field({ label: t("ui.accept.invitation"), name: "invitation", multiline: true, onChange: (v) => (values.invitation = v) }),
    Field({ label: t("ui.accept.password"), name: "password", type: "password", onChange: (v) => (values.password = v) }),
    Field({ label: t("ui.accept.password_again"), name: "again", type: "password", onChange: (v) => (values.again = v) }),
    ErrorLine({ text: props.error }),
    h("button", { type: "submit", className: "primary" }, t("ui.accept.submit")),
  );
}

export function UnlockScreen(props: { locked: boolean; error: string | null; onSubmit?: (password: string) => void }): ReactNode {
  let password = "";
  return h(
    "form",
    { "data-view": "unlock", onSubmit: (e: { preventDefault: () => void }) => { e.preventDefault(); props.onSubmit?.(password); } },
    h("h1", null, t("ui.unlock.title")),
    props.locked ? h("p", null, t("ui.unlock.locked")) : null,
    Field({ label: t("ui.unlock.password"), name: "password", type: "password", onChange: (v) => (password = v) }),
    ErrorLine({ text: props.error }),
    h("button", { type: "submit", className: "primary" }, t("ui.unlock.submit")),
  );
}

export function PresenceDialog(props: { error: string | null; onSubmit?: (password: string) => void; onCancel?: () => void }): ReactNode {
  let password = "";
  return h(
    "div",
    { className: "dialog", role: "dialog", "data-view": "presence" },
    h("h2", null, t("ui.presence.title")),
    h("p", null, t("ui.presence.text")),
    Field({ label: t("ui.presence.password"), name: "presence-password", type: "password", onChange: (v) => (password = v) }),
    ErrorLine({ text: props.error }),
    Button({ label: t("ui.presence.submit"), kind: "primary", onClick: () => props.onSubmit?.(password) }),
    Button({ label: t("ui.cancel"), onClick: props.onCancel }),
  );
}

export function ConnectionBanner(props: { offlineSince: string | null; tlsMismatch: { expected: string; seen: string } | null; updateRequired: boolean }): ReactNode {
  if (props.updateRequired) return h("p", { className: "banner", role: "status" }, t("ui.update_required"));
  if (props.tlsMismatch !== null) return h("p", { className: "banner", role: "status" }, t("ui.tls_mismatch", props.tlsMismatch));
  if (props.offlineSince !== null) return h("p", { className: "banner", role: "status" }, t("ui.offline", { since: props.offlineSince }));
  return null;
}
