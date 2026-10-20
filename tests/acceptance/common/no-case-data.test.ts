// T077 — SC-008, принцип VII: данных дел нет. (1) dictionary/source — вывод генератора по приложению
// (сверка байт в байт — tests/contract/dictionary-source.test.ts); (2) после прогона историй стенда
// каждое значение Индикатора в БД — из фикстур стенда или из строк Стоп-листа применённого Словаря;
// (3) векторы нормализации — ровно строки таблицы contracts/normalizaciya-v1.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase, createTestItem, createTestObject, postIndicator, testDictionaryBody } from "../../support/dictionary.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
/** Фикстуры значений стенда (условные, принцип VII). */
const FIXTURES = ["x", "y", "v", "w", "x-y", "Host-1.Example.test", "10.1.2.3", "1 000"];

test("значения Индикаторов после прогона — только фикстуры стенда и строки Стоп-листа", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  await postIndicator(svc, u1, platform.id, "hostname", { value: "Host-1.Example.test" });
  for (const v of ["x", "y", "v", "w"]) await postIndicator(svc, u1, op.id, "username", { value: v });
  const stopValues = testDictionaryBody().stopLists.flatMap((l) => l.rows.map(([, , value]) => value));
  const allowed = new Set([...FIXTURES, ...stopValues]);
  const values = svc.db.prepare("SELECT json_extract(fields, '$.value') AS v FROM record WHERE type = 'indicator'").all().map((r) => r["v"]).filter((v) => v !== null);
  for (const v of values) assert.ok(allowed.has(String(v)), String(v));
});

test("векторы normalizaciya-v1.json — ровно строки таблицы контракта", () => {
  const vectors = (JSON.parse(readFileSync(join(ROOT, "packages/protocol/test/vectors/normalizaciya-v1.json"), "utf8")) as { vectors: { class: string }[] }).vectors;
  const contract = readFileSync(join(ROOT, "specs/005-model-dannyh-i-slovar/contracts/normalizaciya-v1.md"), "utf8");
  const rows = contract.split("\n").filter((l) => /^\| `[^`]+` \| `/.test(l));
  assert.equal(vectors.length, rows.length);
});
