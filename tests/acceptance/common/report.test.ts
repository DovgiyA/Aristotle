// T057 — скелет Отчёта Кейса (DATA-31 … DATA-35; DATA-07, DATA-24): общие разделы и разделы по Классу;
// недостающие — в GET /api/cases/:id; правка Отчёта — в истории Кейса; новый Класс из версии Словаря —
// без новой версии программы.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { EV, applyTestDictionary, createTestCase, createTestItem, nextTestVersion, signWithTestCoordinator } from "../../support/dictionary.ts";

const COMMON = ["Резюме и вывод", "Поступление и цепочка хранения", "Идентификация", "Защита информации", "Связь и сеть", "Следы оператора"];
const END = ["Выводы", "Рекомендации и открытые задачи"];

test("скелет: общие разделы и разделы по Классу; разделов выдачи нет; неизвестный Класс — только общие", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const get = async (q: string) => (await callAs(svc, svc.seniorId, "GET", `/api/report-skeleton?${q}`)).json().sections as string[];
  assert.deepEqual(await get("class=companion"), [...COMMON, "Назначение и полезная нагрузка", "Загрузка и аппаратная обвязка", "Программный стек", ...END]);
  assert.deepEqual(await get("class=flight_controller"), [...COMMON, "Полётный стек и параметры", "Terrain и район применения", "Lua-скрипты", "Логи полётов", ...END]);
  assert.deepEqual(await get("class=radio_module"), [...COMMON, "Радиолинк и ключи сопряжения", ...END]);
  const all = await get("class=companion");
  assert.ok(!all.includes("Индикаторы для сквозного анализа") && !all.includes("Связь с другими изделиями"), "DATA-34");
});

test("missingSections Кейса; правка Отчёта — в истории Кейса", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  await createTestItem(svc, u1, c.id, "radio_module");
  const report = [...COMMON, "Радиолинк и ключи сопряжения", "Выводы"].map((s) => `## ${s}\n\nx\n`).join("\n");
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: 1, fields: { report } })).statusCode, 200);
  const summary = (await callAs(svc, u1, "GET", `/api/cases/${c.id}`)).json();
  assert.deepEqual(summary.missingSections, ["Рекомендации и открытые задачи"]);
  const history = (await callAs(svc, u1, "GET", `/api/records/${c.id}/history`)).json().items;
  assert.ok(history.some((h: { field: string }) => h.field === "report"));
});

test("Класс, добавленный новой версией Словаря, принимается без новой версии программы (DATA-07, DATA-24)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const NEW = "0190a000-0000-7000-8000-00000000c1a5";
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      b.elements.push({ id: NEW, code: "x_class", label: "x", kind: "enum_value", state: "active", sinceVersion: 2, props: { enum: b.elements.find((e) => e.kind === "enum" && e.code === "item_class")!.id } });
      b.templates.push({ class: NEW, blocks: [{ block: "header", fields: [{ label: "x", required: false, defaultSource: "manual", target: { programField: "itemClass" } }] }] });
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await callAs(svc, u1, "POST", "/api/records", { type: "item", fields: { case: c.id, itemClass: NEW } });
  assert.equal(item.statusCode, 201, item.body);
  assert.deepEqual((await callAs(svc, u1, "GET", "/api/form?class=x_class")).json().blocks.map((b: { block: string }) => b.block), ["header"]);
  assert.deepEqual((await callAs(svc, u1, "GET", "/api/report-skeleton?class=x_class")).json().sections, [...COMMON, ...END]);
  void EV;
});

test("T186, T223, DATA-32: Класс не из Словаря (x, constructor, toString, __proto__) — 400, как у /api/form", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  for (const cls of ["x", "constructor", "toString", "__proto__"]) {
    const res = await callAs(svc, svc.seniorId, "GET", `/api/report-skeleton?class=${cls}`);
    assert.deepEqual([res.statusCode, res.json().error], [400, "invalid_request"], cls);
    assert.equal((await callAs(svc, svc.seniorId, "GET", `/api/form?class=${cls}`)).statusCode, 400, cls);
  }
  assert.equal((await callAs(svc, svc.seniorId, "GET", "/api/report-skeleton?class=companion")).statusCode, 200);
});
