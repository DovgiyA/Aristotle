// Вид «Состав Группы»: Члены Группы с подписью, ролью и состоянием — видят все роли (ROLE-36); завести,
// сменить роль, отозвать — Старший (ROLE-21), с подтверждением присутствия (STATION-12). Формы, а не
// диалоги браузера: их значения читаются при отправке.
import type { ReactNode } from "react";
import type { Member, MessageCode, Role } from "@aristotel/protocol/browser";
import { h } from "../h.ts";
import { t } from "../strings.ts";
import { actionsFor } from "../model/actions.ts";
import { Button, Form, Input, Select, Table } from "./common.ts";

export interface MembersProps {
  role: Role;
  members: Member[];
  onAdd?: (label: string, role: Role) => void;
  onSetRole?: (member: Member, role: Role) => void;
  onRevoke?: (member: Member) => void;
}

const ROLES: Role[] = ["participant", "senior", "observer"];
const roleOptions = (): [string, string][] => ROLES.map((r) => [r, t(`role_${r}` as MessageCode)]);

export function MembersView(props: MembersProps): ReactNode {
  const can = actionsFor(props.role).members;
  const rows = props.members.map((m) => [
    m.label,
    t(`role_${m.role}` as MessageCode),
    t(`state_${m.state}` as MessageCode),
    h(
      "span",
      null,
      can.update && m.state === "active"
        ? Select({ name: "role", options: roleOptions(), value: m.role, action: "member.update", onChange: (value) => props.onSetRole?.(m, value as Role) })
        : null,
      can.revoke && m.state === "active" ? Button({ label: t("ui.members.revoke"), name: "member.revoke", kind: "danger", onClick: () => props.onRevoke?.(m) }) : null,
    ),
  ]);
  return h(
    "section",
    { "data-view": "members" },
    h("h2", null, t("ui.nav.members")),
    can.create
      ? Form({
          name: "member.create",
          submit: t("ui.members.add"),
          onSubmit: (v) => props.onAdd?.(v["label"] ?? "", (v["role"] ?? "participant") as Role),
          children: [Input({ label: t("ui.members.label"), name: "label", required: true }), Select({ label: t("ui.members.role"), name: "role", options: roleOptions(), value: "participant" })],
        })
      : null,
    can.revoke ? h("p", { className: "hint" }, t("ui.members.revoke_warning")) : null,
    Table({ columns: [t("ui.members.label"), t("ui.members.role"), t("ui.members.state"), ""], rows, testId: "members-table" }),
  );
}
