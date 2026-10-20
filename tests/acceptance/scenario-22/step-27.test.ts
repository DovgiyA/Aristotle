// Шаг 22.27: запись значения формата «гео» и точности (DICT-65; DICT-14; DATA-16): Код точности из
// перечня geo_precision — по формату; вне открытого перечня — «вне Словаря», а не нарушение формата.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase, createTestObject, postIndicator } from "../../support/dictionary.ts";

test("22.27: 1.5,2.5 km_10 — без меток; 1.5,2.5 km_99 — вне Словаря; Район изъятия — этот Гео-объект", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const geo = await createTestObject(svc, u1, "geo_object", { case: c.id });
  const marks = async (value: string) => (await postIndicator(svc, u1, geo.id, "geo_shape", { value, case: c.id })).json().view.marks as string[];
  assert.deepEqual(await marks("1.5,2.5 km_10"), []);
  assert.deepEqual(await marks("1.5,2.5 km_99"), ["out_of_dictionary"]);
  assert.deepEqual(await marks("1.5,2.5;1.6,2.6;1.7,2.5 district"), []);
  assert.deepEqual(await marks("1.5;2.5 km_10"), ["format_violation"]);
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: 1, fields: { seizureArea: geo.id } })).statusCode, 200);
});
