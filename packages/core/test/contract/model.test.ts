// T043 (часть «Кейс и Изделие») — контракт Записей модели и GET /api/cases/:id (contracts/http-api.md
// фичи 005; конституция III; BANK-26, DATA-27): 201 с Номером и view; 400 model_invalid с
// details.issues; 409 dictionary_missing; права; Наблюдатель и Секрет-Кейс — 404.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../../../tests/support/harness.ts";
import { EV, applyTestDictionary, createTestCase, createTestItem, createTestObject, postIndicator } from "../../../../tests/support/dictionary.ts";

test("POST /api/records case — 201: fields.number и view.label", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const res = await callAs(svc, svc.addMember("У1"), "POST", "/api/records", { type: "case", fields: { shape: EV("case_shape", "single_item") } });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.match(body.fields.number, /^\d{4}-\d{3,}$/);
  assert.equal(body.view.label, body.fields.number);
});

test("400 model_invalid: details.issues — { field, rule, code }", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const res = await callAs(svc, svc.addMember("У1"), "POST", "/api/records", { type: "case", fields: { shape: "x" } });
  assert.equal(res.statusCode, 400);
  const issue = res.json().details.issues[0];
  assert.deepEqual(Object.keys(issue).sort(), ["code", "field", "rule"]);
  assert.equal(issue.field, "shape");
});

test("права: Наблюдатель Кейс не создаёт (403); Наблюдатель и Секрет-Кейс — 404 на /api/cases/:id", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  assert.equal((await callAs(svc, h1, "POST", "/api/records", { type: "case", fields: {} })).statusCode, 403);
  const c = await createTestCase(svc, u1);
  assert.equal((await callAs(svc, h1, "GET", `/api/cases/${c.id}`)).statusCode, 200);
  assert.equal((await callAs(svc, u1, "POST", `/api/records/${c.id}/secret/mark`, { expectedVersion: c.version })).statusCode, 200);
  assert.equal((await callAs(svc, h1, "GET", `/api/cases/${c.id}`)).statusCode, 404);
});

test("GET /api/cases/:id: Кейс, Изделия, подпись, answered; не Кейс — 404", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const res = await callAs(svc, u1, "GET", `/api/cases/${c.id}`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["answered", "case", "items", "label", "missingSections"]);
  assert.equal(body.label, c.fields["number"]);
  assert.deepEqual(body.items.map((i: { id: string }) => i.id), [item.id]);
  assert.equal(body.answered.complete, false, "дата изъятия не отвечена");
  assert.ok(body.answered.missing.includes("seizedAt"));
  assert.equal((await callAs(svc, u1, "GET", `/api/cases/${item.id}`)).statusCode, 404);
});

// T050 (часть «Индикаторы») — схема view, case_required, GET /api/indicators?stopList (DATA-36, DICT-43, DICT-44).

test("view Индикатора: label, canonicalType, normalized, marks, stopList, identifying, autoValue, typeFromNewerVersion", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const res = await postIndicator(svc, u1, op.id, "username", { value: "v" });
  assert.deepEqual(Object.keys(res.json().view).sort(), ["autoState", "autoValue", "canonicalType", "identifying", "label", "marks", "normalized", "stopList", "typeFromNewerVersion"]);
  assert.deepEqual(Object.keys(res.json().view.stopList).sort(), ["list", "listLabel", "note", "text"]);
  for (const m of res.json().view.marks) assert.ok(["out_of_dictionary", "not_normalizable", "format_violation", "unverified"].includes(m));
});

test("400 case_required; GET /api/indicators?stopList — страница с курсором; неизвестный список — 404", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: (await import("../../../../tests/support/dictionary.ts")).T.object("key") } });
  assert.deepEqual([res.statusCode, res.json().error], [400, "case_required"]);
  const page = (await callAs(svc, u1, "GET", "/api/indicators?stopList=common_defaults")).json();
  assert.deepEqual(Object.keys(page).sort(), ["cursor", "items"]);
  assert.equal((await callAs(svc, u1, "GET", "/api/indicators?stopList=x")).statusCode, 404);
});

test("T111: ответы secret/mark и secret/unmark несут view с подписью, как создание и правка", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const mark = await callAs(svc, u1, "POST", `/api/records/${c.id}/secret/mark`, { expectedVersion: c.version });
  assert.equal(mark.json().view.label, c.fields["number"]);
  // Снимает Секрет Старший (ROLE-18).
  const unmark = await callAs(svc, svc.addMember("С2", "senior"), "POST", `/api/records/${c.id}/secret/unmark`, { expectedVersion: mark.json().version });
  assert.equal(unmark.statusCode, 200, unmark.body);
  assert.equal(unmark.json().view.label, c.fields["number"]);
});

test("T141, BANK-31: Номер Кейса ссылкой не служит — Номер вместо Идентификатора в case — model_invalid", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const byNumber = await callAs(svc, u1, "POST", "/api/records", { type: "item", fields: { case: c.fields["number"], itemClass: EV("item_class", "companion") } });
  assert.deepEqual([byNumber.statusCode, byNumber.json().error], [400, "model_invalid"]);
  const byId = await callAs(svc, u1, "POST", "/api/records", { type: "item", fields: { case: c.id, itemClass: EV("item_class", "companion") } });
  assert.equal(byId.statusCode, 201, byId.body);
});
