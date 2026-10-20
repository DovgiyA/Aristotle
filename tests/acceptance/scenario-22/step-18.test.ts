// T027 — шаг 22.18: версия, где изменился только Стоп-лист, — обычная версия: применена, значения
// Банка сверены со Стоп-листом, Пересверки нет (DICT-47, DICT-54).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callMaintenance, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, nextTestVersion, signWithTestCoordinator } from "../../support/dictionary.ts";

test("22.18: версия только со Стоп-листом применяется как обычная; склеек и смены классов нет", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (body) => {
      body.stopLists[0]!.rows.push([T.indicator("username"), "value", "w", "ещё одна учётка по умолчанию"]);
    }),
  );
  const res = await callMaintenance(svc, "POST", "/api/dictionary/versions", v2);
  assert.equal(res.statusCode, 201, res.body);
  const details = JSON.parse(String(svc.db.prepare("SELECT details FROM journal WHERE action = 'dictionary.apply' ORDER BY seq DESC").get()?.["details"]));
  assert.equal(details.number, 2);
  assert.equal(details.synonyms, 0);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM stop_list_entry WHERE normalized = 'w'").get()?.["n"], 1);
});
