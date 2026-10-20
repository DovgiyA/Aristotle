// T040, T055 — GET /api/journal для Наблюдателя: записи о Секрет-Записях исключены при любых
// фильтрах, сквозных номеров нет, страницы — по непрозрачному курсору; после снятия метки видны и
// прежние записи (INBOX-32, VIEW-16, VIEW-58, VIEW-59; contracts/http-api.md фичи 002).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService, type TestService } from "../../../../tests/support/harness.ts";

test("record=<Секрет-Запись> — пустой items, next и cursor — null", async (t) => {
  const svc = await startTestService(t);
  const n1 = svc.addMember("Н1", "observer");
  const secret = (await callAs(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true })).json();
  const res = await callAs(svc, n1, "GET", `/api/journal?record=${secret.id}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { items: [], next: null, cursor: null });
});

/** Обычные и Секрет-Записи вперемешку — 10 раз; вернуть Идентификаторы обычных. */
async function mixed(svc: TestService): Promise<string[]> {
  const visible: string[] = [];
  for (let i = 0; i < 10; i++) {
    visible.push((await callAs(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: `v${i}` } })).json().id);
    await callAs(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: `w${i}` }, secret: true });
  }
  return visible;
}

test("VIEW-59: у Наблюдателя нет seq, historyFrom, historyTo и next; страницы по cursor без потерь и повторов", async (t) => {
  const svc = await startTestService(t);
  const n1 = svc.addMember("Н1", "observer");
  const visible = await mixed(svc);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res = await callAs(svc, n1, "GET", `/api/journal?limit=3${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    assert.equal(res.statusCode, 200);
    const page = res.json();
    assert.equal(page.next, null);
    for (const item of page.items) {
      assert.deepEqual([item.seq, item.historyFrom, item.historyTo], [null, null, null]);
    }
    // Запись службы group-key.create (фича 003) — не из mixed(): её предмет — Ключ Группы.
    seen.push(...page.items.filter((j: { actorId: string | null }) => j.actorId !== null).map((j: { subjectId: string }) => j.subjectId));
    if (page.cursor === null) break;
    assert.equal(typeof page.cursor, "string");
    // Курсор не содержит seq открытым текстом.
    assert.doesNotMatch(page.cursor, /^\d+$/);
    cursor = page.cursor;
  }
  assert.deepEqual(seen, visible);
});

test("VIEW-59: Наблюдателю after — 400; чужой или испорченный курсор — 400", async (t) => {
  const svc = await startTestService(t);
  const n1 = svc.addMember("Н1", "observer");
  await mixed(svc);
  const after = await callAs(svc, n1, "GET", "/api/journal?after=3");
  assert.equal(after.statusCode, 400);
  assert.equal(after.json().error, "invalid_request");
  for (const bad of ["x", "AAAA", "3"]) {
    const res = await callAs(svc, n1, "GET", `/api/journal?cursor=${bad}`);
    assert.equal(res.statusCode, 400, bad);
  }
  // Курсор другого процесса службы недействителен: у него свой ключ.
  const other = await startTestService(t);
  for (const x of ["v", "w"]) await callAs(other, other.seniorId, "POST", "/api/records", { type: "test.note", fields: { x } });
  const page = (await callAs(other, other.seniorId, "GET", "/api/journal?limit=1")).json();
  assert.equal(typeof page.cursor, "string");
  const res = await callAs(svc, n1, "GET", `/api/journal?cursor=${encodeURIComponent(page.cursor)}`);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /курсор/);
});

test("Участник и Старший: seq и next как прежде, cursor ведёт туда же, что after", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  await mixed(svc);
  const first = (await callAs(svc, u1, "GET", "/api/journal?limit=4")).json();
  assert.equal(typeof first.items[0].seq, "number");
  assert.equal(typeof first.next, "number");
  assert.equal(typeof first.cursor, "string");
  const byAfter = (await callAs(svc, u1, "GET", `/api/journal?limit=4&after=${first.next}`)).json();
  const byCursor = (await callAs(svc, u1, "GET", `/api/journal?limit=4&cursor=${encodeURIComponent(first.cursor)}`)).json();
  assert.deepEqual(byCursor.items, byAfter.items);
});

test("VIEW-59: история обычной Записи у Наблюдателя — без seq строк", async (t) => {
  const svc = await startTestService(t);
  const n1 = svc.addMember("Н1", "observer");
  const record = (await callAs(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  await callAs(svc, svc.seniorId, "PATCH", `/api/records/${record.id}`, { expectedVersion: 1, fields: { x: "w" } });
  const items = (await callAs(svc, n1, "GET", `/api/records/${record.id}/history`)).json().items;
  assert.deepEqual(items.map((h: { seq: unknown; version: number }) => [h.seq, h.version]), [[null, 1], [null, 2]]);
  const senior = (await callAs(svc, svc.seniorId, "GET", `/api/records/${record.id}/history`)).json().items;
  assert.equal(typeof senior[0].seq, "number");
});

test("после снятия метки видны и прежние записи о Записи", async (t) => {
  const svc = await startTestService(t);
  const n1 = svc.addMember("Н1", "observer");
  const secret = (await callAs(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true })).json();
  await callAs(svc, svc.seniorId, "POST", `/api/records/${secret.id}/secret/unmark`, { expectedVersion: 1 });
  const items = (await callAs(svc, n1, "GET", `/api/journal?record=${secret.id}`)).json().items;
  assert.deepEqual(items.map((j: { action: string }) => j.action), ["record.create", "record.secret.unmark"]);
});

test("T224, VIEW-16: счётчики применения версии Словаря Наблюдателю — без счётчиков по Секрет-Записям", async (t) => {
  const { callMaintenance } = await import("../../../../tests/support/harness.ts");
  const { T, applyTestDictionary, createTestCase, createTestItem, createTestObject, nextTestVersion, postIndicator, signWithTestCoordinator } = await import("../../../../tests/support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  await postIndicator(svc, u1, platform.id, "os_note", { value: "x" });
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => (b.elements.find((e) => e.id === T.indicator("os_note"))!.props["autoSecret"] = true)));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const details = async (who: string) =>
    ((await callAs(svc, who, "GET", "/api/journal?action=dictionary.apply")).json().items as { details: Record<string, unknown> }[]).find((i) => i.details["number"] === 2)!.details;
  assert.equal((await details(svc.seniorId))["secretMarked"], 1);
  const observer = await details(h1);
  for (const key of ["secretMarked", "stopListGained", "stopListLost"]) assert.equal(key in observer, false, key);
  assert.equal(observer["number"], 2);
});
