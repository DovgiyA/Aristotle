// T068 — шаг 22.5 без Пересверки и поиска дублей: склейка двух типов Сети синонимом и местного типа A
// в тип Сети; Индикаторы не переписаны и читаются по канону; каждое значение сверено со Стоп-листом;
// журнал со счётчиками; событие после фиксации (DICT-12, DICT-18, DICT-22, DICT-23, DICT-46;
// Clarifications фичи 005).
import { test } from "node:test";
import assert from "node:assert/strict";
import { networkEvents } from "@aristotel/core";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, createTestCase, createTestObject, nextTestVersion, postIndicator, proposeLocal, signWithTestCoordinator } from "../../support/dictionary.ts";

test("22.5: синоним и склейка местного типа; Записи не переписаны, канон — в view; журнал и событие", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const cs = (await postIndicator(svc, u1, op.id, "callsign", { value: "  X " })).json();
  const local = await proposeLocal(svc, u1, "type", { code: "x_quirk", label: "x", object: T.object("operator"), format: "строка:64" });
  const localId = local.json().resultId as string;
  const loc = (await callAs(svc, u1, "POST", "/api/records", { type: "indicator", fields: { object: op.id, type: localId, value: "y", source: { kind: "manual" }, case: c.id } })).json();
  const historyBefore = (await callAs(svc, u1, "GET", `/api/records/${cs.id}/history`)).json().items.length;
  let event: number | undefined;
  const listener = (n: number) => (event = n);
  networkEvents.on("dictionary-applied", listener);
  t.after(() => networkEvents.off("dictionary-applied", listener));
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      const callsign = b.elements.find((e) => e.id === T.indicator("callsign"))!;
      callsign.state = "absorbed";
      callsign.canonical = T.indicator("username");
      b.merges.push({ absorbed: T.indicator("callsign"), canonical: T.indicator("username") });
      b.merges.push({ local: "A:x_quirk", localId, canonical: T.indicator("username") });
    }),
  );
  const res = await callMaintenance(svc, "POST", "/api/dictionary/versions", v2);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(event, 2);
  const after = (await callAs(svc, u1, "GET", `/api/records/${cs.id}`)).json();
  assert.equal(after.version, 1, "Запись не переписана");
  assert.equal(after.fields["type"], T.indicator("callsign"), "тип как записан");
  assert.equal(after.view.canonicalType, T.indicator("username"));
  assert.equal(after.view.normalized, "x", "нормализация — по Классу канона");
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${cs.id}/history`)).json().items.length, historyBefore);
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${loc.id}`)).json().view.canonicalType, T.indicator("username"), "местный тип склеен в тип Сети");
  assert.equal(svc.db.prepare("SELECT state FROM dict_element WHERE id = ?").get(localId)?.["state"], "absorbed");
  const details = JSON.parse(String(svc.db.prepare("SELECT details FROM journal WHERE action = 'dictionary.apply' AND subjectId = '2'").get()?.["details"]));
  assert.deepEqual([details.synonyms, details.localTypesMerged], [1, 1]);
  assert.equal(typeof details.stopListGained, "number");
  // T102, US6/AC6: журнал называет склеенные типы, а не только их число.
  assert.deepEqual(details.mergedTypes, [
    { absorbed: T.indicator("callsign"), absorbedCode: "callsign", canonical: T.indicator("username"), canonicalCode: "username" },
    { absorbed: localId, absorbedCode: "A:x_quirk", canonical: T.indicator("username"), canonicalCode: "username" },
  ]);
});

test("22.5, DICT-23: у Группы без названного местного типа склейка ничего не меняет", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => b.merges.push({ local: "C:x_quirk", localId: "0190a000-0000-7000-8000-00000000cccc", canonical: T.indicator("username") })));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const details = JSON.parse(String(svc.db.prepare("SELECT details FROM journal WHERE action = 'dictionary.apply' AND subjectId = '2'").get()?.["details"]));
  assert.equal(details.localTypesMerged, 0);
});

test("T082, ROLE-25: местный автоматический Секрет поглощённого типа действует и после склейки", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  assert.equal((await proposeLocal(svc, u1, "override", { element: T.indicator("callsign"), property: "autoSecret", value: true })).statusCode, 200);
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      const callsign = b.elements.find((e) => e.id === T.indicator("callsign"))!;
      callsign.state = "absorbed";
      callsign.canonical = T.indicator("username");
      b.merges.push({ absorbed: T.indicator("callsign"), canonical: T.indicator("username") });
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  assert.equal((await postIndicator(svc, u1, op.id, "callsign", { value: "x" })).json().secret, true);
});

test("T190, ROLE-25: собственный автоматический Секрет местного типа сохраняется после его склейки в тип Сети", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const local = await proposeLocal(svc, u1, "type", { code: "sec_q", label: "x", object: T.object("operator"), format: "строка:64", autoSecret: true });
  const localId = local.json().resultId as string;
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => b.merges.push({ local: "A:sec_q", localId, canonical: T.indicator("username") })));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "indicator", fields: { object: op.id, type: localId, value: "z", source: { kind: "manual" }, case: c.id } });
  assert.equal(res.json().secret, true, res.body);
});
