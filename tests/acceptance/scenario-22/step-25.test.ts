// Шаг 22.25: Коды значений перечней по внешним стандартам — идентификаторы стандартов: значения
// timezone (в том числе прежнее имя зоны) и country — из перечня, без метки «вне Словаря»; Код не
// snake_case у обычного перечня — версия не по формату (DICT-09, DICT-14, DICT-63).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SlovarFormatError, parseSlovarBody } from "@aristotel/protocol";
import { startTestService } from "../../support/harness.ts";
import { EV, applyTestDictionary, createTestCase, createTestItem, createTestObject, postIndicator, testDictionaryBody } from "../../support/dictionary.ts";

test("22.25: Europe/Kyiv, Europe/Kiev и UA — значения из перечня; Europe/Moon — вне Словаря", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const marks = async (type: string, value: string) => (await postIndicator(svc, u1, platform.id, type, { value })).json().view.marks as string[];
  assert.deepEqual(await marks("timezone", "Europe/Kyiv"), []);
  assert.deepEqual(await marks("timezone", "Europe/Kiev"), [], "прежнее имя зоны — ссылка на действующее");
  assert.deepEqual(await marks("country", "UA"), []);
  assert.deepEqual(await marks("timezone", "Europe/Moon"), ["out_of_dictionary"]);
});

test("DICT-63: Код не snake_case допустим только у перечней timezone, country, keyboard", () => {
  parseSlovarBody(JSON.stringify(testDictionaryBody()));
  const body = testDictionaryBody({ change: (b) => (b.elements.find((e) => e.id === EV("os_distro", "debian"))!.code = "Debian/X") });
  assert.throws(() => parseSlovarBody(JSON.stringify(body)), SlovarFormatError);
});
