// Вид «Журнал» — все роли (ROLE-22, INBOX-32): фильтры по Члену Группы и виду действия из словаря
// видов записей, продолжение по курсору; Наблюдателю
// записи о Секрет-Записях не приходят (VIEW-58), сквозных номеров нет (VIEW-59).
import type { ReactNode } from "react";
import { JOURNAL_ACTIONS, type JournalItem, type Member, type MessageCode } from "@aristotel/protocol/browser";
import { h } from "../h.ts";
import { t } from "../strings.ts";
import type { JournalFilters } from "../model/journal.ts";
import { Button, Table } from "./common.ts";

export interface JournalProps {
  items: JournalItem[];
  members: Member[];
  filters: JournalFilters;
  onFilter?: (filters: JournalFilters) => void;
  /** Курсор следующей страницы; null — страниц больше нет. */
  cursor?: string | null;
  onMore?: () => void;
}

/** Вид действия — подписью из локализации; неизвестный словарю вид — как есть (APP-09). */
export function actionLabel(action: string): string {
  return (JOURNAL_ACTIONS as readonly string[]).includes(action) ? t(`ui.journal.action.${action}` as MessageCode) : action;
}

/** Предмет записи; у приёма Станции — отпечаток её ключа (FR-008: «Станция принята» с отпечатком). */
function subjectText(item: JournalItem): string {
  const fingerprint = item.details?.["keyFingerprint"];
  return item.action === "station.accept" && typeof fingerprint === "string" ? fingerprint : item.subjectId;
}

export function JournalView(props: JournalProps): ReactNode {
  const select = (name: string, value: string | undefined, options: [string, string][], change: (v: string) => void) =>
    h(
      "select",
      { name, value: value ?? "", onChange: (e: { target: { value: string } }) => change(e.target.value) },
      h("option", { value: "" }, t("ui.journal.all")),
      ...options.map(([v, label]) => h("option", { key: v, value: v }, label)),
    );
  const rows = props.items.map((item, index) => [String(item.seq ?? index + 1), item.at, item.actorLabel, actionLabel(item.action), subjectText(item)]);
  return h(
    "section",
    { "data-view": "journal" },
    h("h2", null, t("ui.nav.journal")),
    h(
      "div",
      { className: "filters" },
      h("label", null, t("ui.journal.member"), select("member", props.filters.member, props.members.map((m) => [m.id, m.label]), (v) => props.onFilter?.({ ...props.filters, member: v }))),
      h("label", null, t("ui.journal.action"), select("action", props.filters.action, JOURNAL_ACTIONS.map((a) => [a, actionLabel(a)]), (v) => props.onFilter?.({ ...props.filters, action: v }))),
      // Кейс — по Идентификатору; фильтр применяется, когда поле покидают (INBOX-32, фича 005).
      h(
        "label",
        null,
        t("ui.journal.case"),
        h("input", {
          name: "case",
          defaultValue: props.filters.case ?? "",
          onBlur: (e: { currentTarget: { value: string } }) => props.onFilter?.({ ...props.filters, case: e.currentTarget.value }),
        }),
      ),
    ),
    Table({ columns: [t("ui.journal.seq"), t("ui.journal.at"), t("ui.journal.actor"), t("ui.journal.action"), t("ui.journal.subject")], rows }),
    props.cursor === undefined || props.cursor === null ? null : Button({ label: t("ui.journal.more"), name: "journal.more", onClick: props.onMore }),
  );
}
