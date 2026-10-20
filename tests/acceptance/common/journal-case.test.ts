// T072 — журнал по Кейсу (SC-007; INBOX-32, INBOX-30, DATA-36, ROLE-07, VIEW-59): все действия по
// Кейсу и ни одного чужого; Индикатор общего узла — в журнале своего Кейса; фильтры складываются;
// Наблюдатель — без Секрет-Записей и без seq; принадлежность не меняется после Отклонения Кейсов.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, runCli, startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase, createTestItem, createTestObject, postIndicator } from "../../support/dictionary.ts";

test("фильтр case: только действия по Кейсу; общий узел — по принадлежности; складывается с action и member", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  const a = await createTestCase(svc, u1);
  const b = await createTestCase(svc, u2);
  const ia = await createTestItem(svc, u1, a.id);
  await createTestItem(svc, u2, b.id);
  const shared = await createTestObject(svc, u1, "operator", { case: a.id });
  const fromA = (await postIndicator(svc, u1, shared.id, "username", { value: "x" })).json();
  const fromB = (await postIndicator(svc, u2, shared.id, "callsign", { value: "y", case: b.id })).json();
  const journal = async (q: string, as = u1) => (await callAs(svc, as, "GET", `/api/journal?${q}`)).json().items as { subjectId: string; caseId: string | null; actorId: string; action: string; seq: number | null }[];
  const ofA = await journal(`case=${a.id}`);
  assert.ok(ofA.every((i) => i.caseId === a.id));
  const subjectsA = new Set(ofA.map((i) => i.subjectId));
  for (const id of [a.id, ia.id, shared.id, fromA.id]) assert.ok(subjectsA.has(id), id);
  assert.ok(!subjectsA.has(fromB.id), "Индикатор общего узла из Кейса B — в журнале B");
  assert.ok((await journal(`case=${b.id}`)).some((i) => i.subjectId === fromB.id));
  assert.ok((await journal(`case=${a.id}&action=record.update`)).every((i) => i.action === "record.update"));
  assert.deepEqual([...new Set((await journal(`case=${b.id}&member=${u2}`)).map((i) => i.actorId))], [u2]);
  const all = await journal("action=member.create");
  assert.ok(all.every((i) => i.caseId === null), "действия без Кейса — caseId null");
});

test("Наблюдатель по Кейсу не видит Секрет-Записей и seq; Кейсы отклонены — принадлежность прежняя", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  const a = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: a.id });
  const secret = (await postIndicator(svc, u1, op.id, "username", { value: "x" })).json();
  await callAs(svc, u1, "POST", `/api/records/${secret.id}/secret/mark`, { expectedVersion: 1 });
  const items = (await callAs(svc, h1, "GET", `/api/journal?case=${a.id}`)).json().items as { subjectId: string; seq: number | null }[];
  assert.ok(items.length > 0);
  assert.ok(!items.some((i) => i.subjectId === secret.id));
  assert.ok(items.every((i) => i.seq === null));
  svc.db.prepare("UPDATE record SET fields = json_set(fields, '$.status', 'rejected') WHERE id = ?").run(a.id);
  const still = (await callAs(svc, u1, "GET", `/api/journal?case=${a.id}`)).json().items as { subjectId: string }[];
  assert.ok(still.some((i) => i.subjectId === op.id));
  void runCli;
});

test("T100, ROLE-07: Секрет-Кейс — Наблюдатель не получает его Идентификатора ни в caseId, ни через фильтр", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  const a = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: a.id });
  await postIndicator(svc, u1, op.id, "callsign", { value: "y" });
  assert.equal((await callAs(svc, u1, "POST", `/api/records/${a.id}/secret/mark`, { expectedVersion: 1 })).statusCode, 200);
  const filtered = (await callAs(svc, h1, "GET", `/api/journal?case=${a.id}`)).json().items as unknown[];
  assert.deepEqual(filtered, [], "фильтр по Секрет-Кейсу — как по неизвестному");
  const all = (await callAs(svc, h1, "GET", "/api/journal?limit=1000")).json();
  assert.ok(!JSON.stringify(all).includes(a.id), "Идентификатора Секрет-Кейса в журнале Наблюдателя нет");
  // Участник видит всё по-прежнему.
  assert.ok(((await callAs(svc, u1, "GET", `/api/journal?case=${a.id}`)).json().items as unknown[]).length > 0);
});
