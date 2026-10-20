// Схемы журнала и его фильтров (INBOX-32; data-model.md «journal»; contracts/http-api.md).
import { Type, type Static } from "typebox";

export const JournalItem = Type.Object({
  /** Сквозной номер журнала; Наблюдателю — null (VIEW-59). */
  seq: Type.Union([Type.Integer(), Type.Null()]),
  at: Type.String(),
  /** Член Группы — автор; null — служба Опорной станции (research R11 фичи 003). */
  actorId: Type.Union([Type.String(), Type.Null()]),
  /** Подпись Члена Группы для людей — чтобы CLI и интерфейс показывали «кто» без второго запроса;
   * для службы — «служба Опорной станции». */
  actorLabel: Type.String(),
  action: Type.String(),
  subjectType: Type.String(),
  subjectId: Type.String(),
  historyFrom: Type.Union([Type.Integer(), Type.Null()]),
  historyTo: Type.Union([Type.Integer(), Type.Null()]),
  details: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  /** Кейс, к которому относится действие (DATA-36, INBOX-32); null — не к Кейсу. */
  caseId: Type.Union([Type.String(), Type.Null()]),
});

export type JournalItem = Static<typeof JournalItem>;

/**
 * Виды записей журнала — закрытый словарь: фильтр вида «Журнал» предлагает их все, а не только
 * встретившиеся на показанной странице (INBOX-32). Новый вид записи добавляется сюда; полноту
 * проверяет tests/acceptance/common/journal-actions.test.ts.
 */
export const JOURNAL_ACTIONS = [
  "member.bootstrap",
  "member.create",
  "member.update",
  "member.revoke",
  "record.create",
  "record.update",
  "record.secret.mark",
  "record.secret.unmark",
  "group-key.create",
  "group-key.unavailable",
  "coordinator-key.register",
  "coordinator-key.withdraw",
  "registry.apply",
  "registry.reject",
  "registry.conflict",
  "relay.login-failed",
  "relay.tls-mismatch",
  "relay.registry-conflict",
  "invitation.issue",
  "invitation.cancel",
  "station.accept",
  "station.session.start",
  "station.session.end",
  "station.revoke",
  "station.deletion.confirm",
  "group-setting.update",
  // Фича 005 (data-model.md «Журнал»).
  "dictionary.apply",
  "dictionary.reject",
  "dictionary.conflict",
  "local-extension.propose",
  "local-extension.accept",
  "local-extension.reject",
  "local-extension.change",
  "stop-list.local.add",
  "stop-list.local.remove",
  // Фича 006 (data-model.md «Виды действий журнала»).
  "material.register",
  "material.attestation.reject",
  "material.deliver",
  "material.deliver.reject",
  "material.kind.set",
  "material.kind.release",
  "material.delete",
] as const;
export type JournalAction = (typeof JOURNAL_ACTIONS)[number];

export const JournalQuery = Type.Object(
  {
    member: Type.Optional(Type.String()),
    record: Type.Optional(Type.String()),
    /** Кейс: действия по нему и по Записям, отнесённым к нему (INBOX-32, DATA-36). */
    case: Type.Optional(Type.String()),
    action: Type.Optional(Type.String()),
    after: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Непрозрачный курсор из ответа — продолжает с того же места, что after (VIEW-59). */
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
  },
  { additionalProperties: false },
);

export type JournalQuery = Static<typeof JournalQuery>;

export const JournalResponse = Type.Object({
  items: Type.Array(JournalItem),
  /** seq для after; Наблюдателю — null (VIEW-59). */
  next: Type.Union([Type.Integer(), Type.Null()]),
  /** Непрозрачный курсор следующей страницы или null. */
  cursor: Type.Union([Type.String(), Type.Null()]),
});

export type JournalResponse = Static<typeof JournalResponse>;
