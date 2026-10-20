// T055 — сценарий 17, шаг 17.16: Н1 листает журнал страницами и открывает историю обычной Записи —
// без сквозных номеров, следующая страница по непрозрачному курсору; по ответам не узнать, сколько
// записей о Секрет-Записях скрыто (VIEW-59, VIEW-16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, groupA, startTestService, type TestService } from "../../support/harness.ts";

/** Всё, что Н1 получает, листая журнал по 2 записи, и история обычной Записи. */
async function observerView(svc: TestService, n1: string, recordId: string): Promise<unknown> {
  const pages: unknown[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: Record<string, unknown>[]; next: unknown; cursor: string | null } = (
      await callAs(svc, n1, "GET", `/api/journal?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`)
    ).json();
    // Курсор непрозрачен и случаен — сравниваются только данные страниц. У записи службы group-key.create
    // (фича 003) в details отпечаток своего Ключа Группы — у каждой службы стенда он свой.
    const comparable = ({ at: _at, subjectId: _s, actorId: _a, details, ...rest }: Record<string, unknown>) =>
      rest["subjectType"] === "group-key" ? rest : { ...rest, details };
    pages.push({ items: page.items.map(comparable), next: page.next, more: page.cursor !== null });
    cursor = page.cursor;
  } while (cursor !== null);
  const history = (await callAs(svc, n1, "GET", `/api/records/${recordId}/history`)).json().items.map(
    ({ at: _at, authorId: _a, ...rest }: Record<string, unknown>) => rest,
  );
  return { pages, history };
}

/** Группа A, где С1 правит обычную Запись; hidden — сколько изменений Секрет-Записи вклинить между ними. */
async function scenario(t: Parameters<typeof startTestService>[0], hidden: number): Promise<unknown> {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const plain = (await callAs(svc, a.c1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const secret = (await callAs(svc, a.u1, "POST", "/api/records", { type: "test.note", fields: { x: "y" }, secret: true })).json();
  for (let i = 0; i < hidden; i++) {
    await callAs(svc, a.u1, "PATCH", `/api/records/${secret.id}`, { expectedVersion: i + 1, fields: { x: `y${i}` } });
  }
  await callAs(svc, a.c1, "PATCH", `/api/records/${plain.id}`, { expectedVersion: 1, fields: { x: "w" } });
  await callAs(svc, a.c1, "POST", "/api/records", { type: "test.note", fields: { x: "z" } });
  return observerView(svc, a.n1, plain.id);
}

test("17.16: ответы Н1 одинаковы, сколько бы изменений Секрет-Записи ни было скрыто", async (t) => {
  const none = await scenario(t, 0);
  const many = await scenario(t, 5);
  assert.deepEqual(many, none);
});
