// T062 — шаг 22.1 до границы пакета: местный тип живёт в Местном расширении A и с другими Группами не
// сопоставляется; в определении нет значений из Кейсов (DICT-03 … DICT-06, DICT-11, DICT-22). Пакет
// «предложение в Словарь Сети» — фичи 020, 010.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, proposeLocal } from "../../support/dictionary.ts";

test("22.1: местный тип — в Местном расширении, не сопоставляется; определение без значений", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const res = await proposeLocal(svc, u1, "type", { code: "x_quirk", label: "x", object: T.object("operator"), format: "строка:64" });
  assert.equal(res.statusCode, 200, res.body);
  const own = (await callAs(svc, u1, "GET", "/api/local-extension")).json();
  const type = own.types.find((x: { code: string }) => x.code === "A:x_quirk");
  assert.deepEqual(Object.keys(type).sort(), ["canonicalId", "code", "id", "label", "props", "state"], "T229: канон — часть определения, значений нет");
  assert.equal(type.props.comparable, false);
  assert.deepEqual(Object.keys(type.props).sort(), ["autoSecret", "comparable", "format", "identifying", "normClass", "object"]);
});
