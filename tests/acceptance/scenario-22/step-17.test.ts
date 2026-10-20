// T048 — шаг 22.17 без Пересверки: типу назначен другой Класс нормализации новым именем версии —
// нормализованные формы пересчитаны, значения хранятся как введены (DICT-26, DICT-37). Пересверка —
// фича 021.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, createTestCase, createTestItem, createTestObject, nextTestVersion, postIndicator, signWithTestCoordinator } from "../../support/dictionary.ts";

test("22.17: os_note со «строки» на «строку-без-регистра» — нормализованная форма пересчитана при применении", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const rec = (await postIndicator(svc, u1, platform.id, "os_note", { value: "  Straße X " })).json();
  assert.equal(rec.view.normalized, "Straße X");
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => (b.elements.find((e) => e.id === T.indicator("os_note"))!.props["normClass"] = "строка-без-регистра")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const after = (await callAs(svc, u1, "GET", `/api/records/${rec.id}`)).json();
  assert.equal(after.fields["value"], "  Straße X ");
  assert.equal(after.view.normalized, "strasse x");
  assert.equal(after.version, 1, "Запись не переписана");
});
