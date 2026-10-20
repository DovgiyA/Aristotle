// Вид «Приглашения» — Старшим (STATION-13): выпуск с подтверждением присутствия, строка показывается
// один раз; перечень без строк и секретов; отмена без пароля (STATION-44).
import type { ReactNode } from "react";
import type { InvitationView, Member, MessageCode, Role } from "@aristotel/protocol/browser";
import { h } from "../h.ts";
import { t } from "../strings.ts";
import { actionsFor } from "../model/actions.ts";
import { Button, Form, Select, Table } from "./common.ts";

export interface InvitationsProps {
  role: Role;
  invitations: InvitationView[];
  /** Только что выпущенная строка — показывается один раз. */
  fresh?: string | null;
  /** Кому можно выпустить: действующие Члены Группы (себе — отказ invitation_self). */
  members?: Member[];
  onIssue?: (memberId: string) => void;
  onCancel?: (invitation: InvitationView) => void;
}

export function InvitationsView(props: InvitationsProps): ReactNode {
  const can = actionsFor(props.role).invitations;
  if (!can.view) return null;
  const rows = props.invitations.map((i) => [
    i.memberLabel,
    i.expiresAt,
    t(`invitation_view_${i.view}` as MessageCode),
    i.view === "issued" && can.cancel ? Button({ label: t("ui.invitations.cancel"), name: "invitation.cancel", onClick: () => props.onCancel?.(i) }) : null,
  ]);
  return h(
    "section",
    { "data-view": "invitations" },
    h("h2", null, t("ui.nav.invitations")),
    can.issue
      ? Form({
          name: "invitation.issue",
          submit: t("ui.invitations.issue"),
          onSubmit: (v) => {
            if (v["memberId"] !== undefined && v["memberId"] !== "") props.onIssue?.(v["memberId"]);
          },
          children: [
            Select({
              label: t("ui.invitations.for"),
              name: "memberId",
              options: (props.members ?? []).filter((m) => m.state === "active").map((m) => [m.id, m.label]),
            }),
          ],
        })
      : null,
    props.fresh === undefined || props.fresh === null ? null : h("div", { className: "once" }, h("p", null, t("ui.invitations.once")), h("pre", null, props.fresh)),
    Table({ columns: [t("ui.invitations.for"), t("ui.invitations.until"), t("ui.invitations.state"), ""], rows }),
  );
}
