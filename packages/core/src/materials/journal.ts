// Записи журнала Материалов, у которых нет правки полей Записи: доставка, отказ доставки или Заверения
// (data-model.md «Виды действий журнала» фичи 006; INBOX-30). actorId NULL — служба (доставка с
// носителя, доведение после сбоя).
import type { Db } from "../db/open.ts";

export function materialJournal(db: Db, action: string, materialId: string, actorId: string | null, details: Record<string, unknown> | null, caseId: string | null): void {
  db.prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId, details, caseId) VALUES (?, ?, ?, 'record', ?, ?, ?)").run(
    new Date().toISOString(),
    actorId,
    action,
    materialId,
    details === null ? null : JSON.stringify(details),
    caseId,
  );
}
