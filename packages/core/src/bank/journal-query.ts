// Чтение журнала с фильтрами и страницами (INBOX-32). Чтение в журнал не пишется (INBOX-31).
// Журнал читают все Члены Группы (ROLE-22); Наблюдатель — без записей о Секрет-Записях и без
// сквозных номеров, страницы — по непрозрачному курсору (VIEW-16, VIEW-58, VIEW-59). Автор записи
// может быть службой Опорной станции — actorId = NULL (research R11 фичи 003).
import { message, type JournalItem, type JournalQuery, type JournalResponse } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import type { JournalCursor } from "./journal-cursor.ts";
import { journalVisibilitySql, seesSequenceNumbers, type Reader } from "./visibility.ts";

export function queryJournal(db: Db, query: JournalQuery, reader: Reader | undefined, cursors: JournalCursor): JournalResponse {
  const numbered = seesSequenceNumbers(reader);
  // Наблюдатель не задаёт seq сам: подбором after он восстановил бы нумерацию (VIEW-59).
  if (!numbered && query.after !== undefined) throw new ApiError("invalid_request", { detail: message("detail_after_not_allowed") });
  const start = query.cursor !== undefined ? cursors.decode(query.cursor) : (query.after ?? 0);
  const where: string[] = ["j.seq > ?"];
  // Фильтр видимости — в WHERE до LIMIT: страницы считаются по видимым записям.
  const visibility = journalVisibilitySql(reader);
  if (visibility !== "") where.push(visibility);
  const params: (string | number)[] = [start];
  if (query.member !== undefined) {
    where.push("j.actorId = ?");
    params.push(query.member);
  }
  if (query.record !== undefined) {
    where.push("j.subjectType = 'record' AND j.subjectId = ?");
    params.push(query.record);
  }
  // По Кейсу — по колонке caseId, записанной в момент действия (INBOX-32, DATA-36; research R12 фичи 005).
  // Наблюдателю Секрет-Кейс — как неизвестный: ни строк по фильтру, ни его Идентификатора (ROLE-07).
  const hidesSecretCases = reader !== undefined && reader.role === "observer";
  if (query.case !== undefined) {
    where.push("j.caseId = ?");
    params.push(query.case);
    if (hidesSecretCases) where.push("NOT EXISTS (SELECT 1 FROM record c WHERE c.id = j.caseId AND c.secret = 1)");
  }
  if (query.action !== undefined) {
    where.push("j.action = ?");
    params.push(query.action);
  }
  const limit = query.limit ?? 100;
  // На одну строку больше страницы — чтобы узнать, есть ли следующая.
  const rows = db
    .prepare(
      `SELECT j.*, m.label AS actorLabel, (SELECT c.secret FROM record c WHERE c.id = j.caseId) AS caseSecret FROM journal j LEFT JOIN member m ON m.id = j.actorId
       WHERE ${where.join(" AND ")} ORDER BY j.seq LIMIT ?`,
    )
    .all(...params, limit + 1);
  const page = rows.slice(0, limit);
  const items: JournalItem[] = page.map((r) => ({
    seq: numbered ? Number(r["seq"]) : null,
    at: String(r["at"]),
    actorId: r["actorId"] === null ? null : String(r["actorId"]),
    actorLabel: r["actorId"] === null ? message("actor_service") : String(r["actorLabel"]),
    action: String(r["action"]),
    subjectType: String(r["subjectType"]),
    subjectId: String(r["subjectId"]),
    historyFrom: !numbered || r["historyFrom"] === null ? null : Number(r["historyFrom"]),
    historyTo: !numbered || r["historyTo"] === null ? null : Number(r["historyTo"]),
    details: r["details"] === null ? null : visibleDetails(String(r["action"]), JSON.parse(String(r["details"])) as Record<string, unknown>, hidesSecretCases),
    caseId: r["caseId"] === null || r["caseId"] === undefined || (hidesSecretCases && Number(r["caseSecret"]) === 1) ? null : String(r["caseId"]),
  }));
  const last = page[page.length - 1];
  const next = rows.length > limit && last !== undefined ? Number(last["seq"]) : null;
  return { items, next: numbered ? next : null, cursor: next === null ? null : cursors.encode(next) };
}

/**
 * Счётчики применения версии Словаря, которые считают и Секрет-Записи, Наблюдателю не идут: сводки у
 * него считаются без Секрет-Записей (VIEW-16; T224).
 */
const SECRET_COUNTERS: Record<string, readonly string[]> = { "dictionary.apply": ["secretMarked", "stopListGained", "stopListLost"] };

function visibleDetails(action: string, details: Record<string, unknown>, observer: boolean): Record<string, unknown> {
  const hidden = observer ? SECRET_COUNTERS[action] : undefined;
  if (hidden === undefined || !Object.hasOwn(SECRET_COUNTERS, action)) return details;
  return Object.fromEntries(Object.entries(details).filter(([key]) => !hidden.includes(key)));
}
