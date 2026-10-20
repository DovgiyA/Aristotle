// Фильтры вида «Журнал»: по Члену Группы, виду действия и Кейсу (INBOX-32; по Кейсу — фича 005, по
// Агенту и Поручению — фича 016).
export interface JournalFilters {
  member?: string;
  action?: string;
  /** Идентификатор Кейса. */
  case?: string;
}

/** Запрос страницы журнала; cursor — продолжение из прошлого ответа (VIEW-59). */
export function journalQuery(filters: JournalFilters, limit = 200, cursor?: string | null): string {
  const query = new URLSearchParams();
  if (filters.member !== undefined && filters.member !== "") query.set("member", filters.member);
  if (filters.action !== undefined && filters.action !== "") query.set("action", filters.action);
  if (filters.case !== undefined && filters.case.trim() !== "") query.set("case", filters.case.trim());
  query.set("limit", String(limit));
  if (cursor !== undefined && cursor !== null) query.set("cursor", cursor);
  return `/api/journal?${query.toString()}`;
}

/** Виды действий, по которым можно отобрать журнал, — из записей, которые уже видны. */
export function actionsIn(items: { action: string }[]): string[] {
  return [...new Set(items.map((i) => i.action))].sort();
}
