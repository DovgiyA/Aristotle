// T048 — GET /api/journal: фильтры, страницы, чтение журнала в журнал не пишется
// (INBOX-31, INBOX-32; contracts/http-api.md). Первая запись журнала — group-key.create от службы при
// запуске (фича 003, T015): проверки по записям Членов Группы её отбрасывают, страницы — учитывают.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService, type TestService } from "../../../../tests/support/harness.ts";

function as(svc: TestService, memberId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  const headers: Record<string, string> = { ...svc.authHeaders(memberId) };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return svc.app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload: payload as Record<string, unknown> });
}

/** Два Члена Группы, две Записи: У1 создаёт обе, У2 правит первую. */
async function seed(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  const a = (await as(svc, u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const b = (await as(svc, u1, "POST", "/api/records", { type: "test.note", fields: { x: "w" } })).json();
  await as(svc, u2, "PATCH", `/api/records/${a.id}`, { expectedVersion: 1, fields: { x: "y" } });
  return { svc, u1, u2, a: a.id as string, b: b.id as string };
}

type Item = { seq: number; actorId: string | null; actorLabel: string; action: string; subjectId: string; at: string };

const byMembers = (items: Item[]) => items.filter((i) => i.actorId !== null);

async function journal(svc: TestService, memberId: string, query: string): Promise<{ items: Item[]; next: number | null }> {
  const res = await as(svc, memberId, "GET", `/api/journal${query}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

test("без фильтров — все записи по возрастанию seq, с подписью автора", async (t) => {
  const { svc, u1, u2 } = await seed(t);
  const { items: all, next } = await journal(svc, u1, "");
  assert.equal(all[0]?.action, "group-key.create");
  const items = byMembers(all);
  assert.deepEqual(items.map((i) => i.action), ["record.create", "record.create", "record.update"]);
  assert.deepEqual(items.map((i) => i.actorLabel), ["У1", "У1", "У2"]);
  assert.deepEqual(items.map((i) => i.actorId), [u1, u1, u2]);
  assert.equal(next, null);
});

test("фильтры member, record, action и их сочетание (INBOX-32)", async (t) => {
  const { svc, u1, u2, a, b } = await seed(t);
  assert.deepEqual((await journal(svc, u1, `?member=${u2}`)).items.map((i) => i.action), ["record.update"]);
  assert.deepEqual((await journal(svc, u1, `?record=${b}`)).items.map((i) => i.subjectId), [b]);
  assert.equal((await journal(svc, u1, "?action=record.create")).items.length, 2);
  const combined = (await journal(svc, u1, `?member=${u1}&record=${a}&action=record.create`)).items;
  assert.deepEqual(combined.map((i) => [i.actorId, i.subjectId, i.action]), [[u1, a, "record.create"]]);
});

test("страницы: limit и after, next — seq последней записи страницы", async (t) => {
  const { svc, u1 } = await seed(t);
  // Четыре записи: group-key.create службы и три записи Членов Группы.
  const first = await journal(svc, u1, "?limit=3");
  assert.equal(first.items.length, 3);
  assert.equal(first.next, first.items[2]?.seq);
  const second = await journal(svc, u1, `?limit=3&after=${first.next}`);
  assert.equal(second.items.length, 1);
  assert.equal(second.next, null);
  for (const bad of ["0", "1001", "x"]) {
    const res = await as(svc, u1, "GET", `/api/journal?limit=${bad}`);
    assert.equal(res.statusCode, 400, `limit=${bad}`);
  }
});

test("чтение журнала в журнал не пишет (INBOX-31)", async (t) => {
  const { svc, u1 } = await seed(t);
  await journal(svc, u1, "");
  await journal(svc, u1, "?action=record.update");
  assert.equal(byMembers((await journal(svc, u1, "")).items).length, 3);
});

// T073 (фича 005) — параметр case и caseId в элементе ответа (contracts/http-api.md фичи 005 «Журнал»;
// INBOX-32): несуществующий Кейс — пустая страница; лишний параметр отбрасывается, как у всех маршрутов.
import { applyTestDictionary as applyDict005, createTestCase as createCase005 } from "../../../../tests/support/dictionary.ts";

test("журнал: case — в схеме запроса, caseId — в элементе; неизвестный Кейс — пустая страница; лишний параметр отбрасывается", async (t) => {
  const { startTestService: start, callAs: call } = await import("../../../../tests/support/harness.ts");
  const svc = await start(t);
  await applyDict005(svc);
  const u1 = svc.addMember("У1");
  const c = await createCase005(svc, u1);
  const page = (await call(svc, u1, "GET", `/api/journal?case=${c.id}`)).json();
  assert.ok(page.items.length > 0);
  assert.ok(Object.hasOwn(page.items[0], "caseId"));
  assert.deepEqual((await call(svc, u1, "GET", "/api/journal?case=x")).json().items, []);
  // Как у всех маршрутов фич 001–004: лишние параметры запроса Fastify отбрасывает (removeAdditional).
  assert.equal((await call(svc, u1, "GET", "/api/journal?kase=x")).statusCode, 200);
});
