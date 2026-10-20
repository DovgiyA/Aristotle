// T056 — описание Формуляра по Классу и подтипу (DATA-14 … DATA-19, DATA-22, DATA-23, DICT-08):
// блоки по шаблону Класса, обязательность, источник, привязка «куда ложится»; общая часть Кейса;
// поле устаревшего типа — deprecated (Edge Cases spec.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, nextTestVersion, signWithTestCoordinator } from "../../support/dictionary.ts";

type Form = { general: { field: string; required: boolean }[]; blocks: { block: string; fields: { label: string; required: boolean; defaultSource: string; target: Record<string, unknown>; local: boolean; deprecated: boolean; format: string | null }[] }[] };

async function form(svc: Awaited<ReturnType<typeof startTestService>>, query: string): Promise<Form> {
  const res = await callAs(svc, svc.seniorId, "GET", `/api/form?${query}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

test("три Класса и подтип: блоки по шаблону; ОС у радиомодуля — только на Linux", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  assert.deepEqual((await form(svc, "class=companion")).blocks.map((b) => b.block), ["header", "media", "os", "class"]);
  assert.deepEqual((await form(svc, "class=flight_controller")).blocks.map((b) => b.block), ["header", "media", "class"]);
  assert.deepEqual((await form(svc, "class=radio_module")).blocks.map((b) => b.block), ["header", "media", "class"]);
  assert.deepEqual((await form(svc, "class=radio_module&onLinux=true")).blocks.map((b) => b.block), ["header", "media", "class", "os"]);
  const bare = await form(svc, "class=flight_controller&subtype=bare_media");
  assert.deepEqual(bare.blocks.map((b) => b.block), ["header", "media", "class"]);
});

test("поле: обязательность, источник, привязка к типам Словаря и связи; «Имя хоста» — Индикатор, учётка — Оператор + авторства", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const f = await form(svc, "class=companion");
  const os = f.blocks.find((b) => b.block === "os")!;
  const host = os.fields.find((x) => x.label === "Имя хоста")!;
  assert.deepEqual([host.required, host.defaultSource], [true, "auto"]);
  assert.deepEqual(host.target, { objectKind: T.object("platform"), indicatorTypes: [T.indicator("hostname")] });
  const login = f.blocks.find((b) => b.block === "class")!.fields[0]!;
  assert.deepEqual(login.target, { objectKind: T.object("operator"), indicatorTypes: [T.indicator("username")], link: T.link("authored_by") });
  assert.equal(host.local, false);
});

test("общая часть Кейса — DATA-14 … DATA-19 с обязательностью", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const f = await form(svc, "class=companion");
  assert.deepEqual(
    f.general.map((g) => [g.field, g.required]),
    [["seizedAt", true], ["receivedAt", true], ["seizureArea", false], ["shape", true], ["boardPhoto", false], ["performers", true]],
  );
});

test("поле устаревшего типа остаётся с deprecated: true", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => (b.elements.find((e) => e.id === T.indicator("hostname"))!.state = "deprecated")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const host = (await form(svc, "class=companion")).blocks.find((b) => b.block === "os")!.fields.find((x) => x.label === "Имя хоста")!;
  assert.equal(host.deprecated, true);
});

test("T085, DATA-27: обязательные поля Носителя проверяются у каждого Носителя; без Носителей — не спрашиваются", async (t) => {
  const { createTestCase, createTestItem, createTestObject, postIndicator, EV } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1, { seizedAt: "2026-10-01" });
  const item = await createTestItem(svc, u1, c.id, "flight_controller");
  const missing = async () => (await callAs(svc, u1, "GET", `/api/cases/${c.id}`)).json().answered.missing as string[];
  assert.ok(!(await missing()).some((m) => m.endsWith("Способ снятия")), "без Носителя блок не спрашивается");
  const media = await createTestObject(svc, u1, "hw_element", { case: c.id });
  await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("has_element"), from: item.id, to: media.id, confidence: "high", source: { kind: "manual" } } });
  await postIndicator(svc, u1, media.id, "hw_kind", { value: "storage" });
  assert.ok((await missing()).some((m) => m.endsWith("Способ снятия")), "Носитель без способа снятия — не отвечен");
  const patched = await callAs(svc, u1, "PATCH", `/api/records/${media.id}`, { expectedVersion: 1, fields: { acquisitionMethod: EV("acquisition_method", "physical_ro") } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.ok(!(await missing()).some((m) => m.endsWith("Способ снятия")));
});

test("T093, DATA-23: у поля — тип значения: формат шаблона, иначе формат типа Индикатора или поля программы", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const f = await form(svc, "class=companion");
  const field = (block: string, label: string) => f.blocks.find((b) => b.block === block)!.fields.find((x) => x.label === label)!;
  assert.equal(field("os", "Имя хоста").format, "имя хоста", "формат шаблона");
  assert.equal(field("os", "Дистрибутив").format, "перечень:os_distro", "формат типа Индикатора");
  assert.equal(field("media", "Способ снятия").format, "перечень:acquisition_method", "поле программы — закрытый перечень");
});

test("T106: поле помечено «устаревшее», когда устарел вид объекта или тип связи", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const operator = (deprecate: (b: import("@aristotel/protocol").SlovarBody) => void) => signWithTestCoordinator(nextTestVersion(v1, deprecate));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", operator((b) => (b.elements.find((e) => e.id === T.link("authored_by"))!.state = "deprecated")))).statusCode, 201);
  const field = (await form(svc, "class=companion")).blocks.find((b) => b.block === "class")!.fields.find((x) => x.label === "Учётка оператора")!;
  assert.equal(field.deprecated, true);
});

test("T195, DATA-27: «отвечено» Изделия — не по Индикаторам другого Изделия, связанного connected_to", async (t) => {
  const { EV, createTestCase, createTestItem, postIndicator, testDictionaryDocument } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const doc = testDictionaryDocument({
    change: (b) => {
      b.elements.push({ id: T.indicator("item_mark"), code: "item_mark", label: "Метка изделия", kind: "indicator_type", state: "active", sinceVersion: 1, props: { object: "@item", format: "строка:64", comparable: false, normClass: null, identifying: "none", autoSecret: false } });
      const tpl = b.templates.find((x) => x.class === EV("item_class", "companion") && x.subtype === undefined)!;
      tpl.blocks.find((x) => x.block === "class")!.fields.push({ label: "Метка изделия", required: true, defaultSource: "manual", target: { objectKind: "@item", indicatorTypes: [T.indicator("item_mark")] } });
    },
  });
  await applyTestDictionary(svc, signWithTestCoordinator(doc));
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1, { shape: EV("case_shape", "airframe") });
  const a = await createTestItem(svc, u1, c.id);
  const b = await createTestItem(svc, u1, c.id);
  assert.equal((await postIndicator(svc, u1, b.id, "item_mark", { value: "m", case: c.id })).statusCode, 201);
  const missing = async () => ((await callAs(svc, u1, "GET", `/api/cases/${c.id}`)).json().answered.missing as string[]).filter((m) => m.endsWith("Метка изделия"));
  assert.equal((await missing()).length, 1, "у первого Изделия метки нет");
  const link = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("connected_to"), from: a.id, to: b.id, confidence: "high", source: { kind: "manual" } } });
  assert.equal(link.statusCode, 201, link.body);
  assert.equal((await missing()).length, 1, "метка второго Изделия первому не засчитана");
});

test("T126: по реальному Словарю — формат каждого типа поля и каждого поля программы (DATA-23)", async (t) => {
  const { buildVersion, readDictionarySource } = await import("@aristotel/core");
  const { join } = await import("node:path");
  const svc = await startTestService(t);
  const source = readDictionarySource(join(import.meta.dirname, "..", "..", "..", "dictionary", "source"));
  await applyTestDictionary(svc, signWithTestCoordinator(buildVersion({ source }).doc));
  const f = (await callAs(svc, svc.seniorId, "GET", "/api/form?class=companion")).json() as {
    blocks: { block: string; fields: { label: string; target: { indicatorTypes?: string[]; programField?: string }; format: string | null; formats: Record<string, string | null> }[] }[];
  };
  const field = (block: string, prefix: string) => f.blocks.find((b) => b.block === block)!.fields.find((x) => x.label.startsWith(prefix))!;
  const cls = field("header", "Класс изделия");
  assert.deepEqual(cls.formats, { itemClass: "перечень:item_class", itemSubtype: "перечень:item_subtype" });
  const os = field("os", "ОС и версия");
  assert.equal(Object.keys(os.formats).length, os.target.indicatorTypes!.length, "формат у каждого типа поля");
  assert.equal(os.formats[os.target.indicatorTypes![0]!], "перечень:os_distro");
  assert.equal(os.format, null, "у поля с несколькими типами одного формата нет");
  const tool = f.blocks.find((b) => b.block === "media")!.fields.find((x) => x.target.programField === "acquisitionTool,intakeStation")!;
  assert.deepEqual(Object.keys(tool.formats).sort(), ["acquisitionTool", "intakeStation"]);
});

test("T203, VIEW-16: «отвечено» Наблюдателю — по видимым Записям: ни Идентификатора Секрет-Записи, ни следа скрытого ответа", async (t) => {
  const { createTestCase, createTestItem, createTestObject, postIndicator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const host = (await postIndicator(svc, u1, platform.id, "hostname", { value: "h1" })).json();
  const media = await createTestObject(svc, u1, "hw_element", { case: c.id });
  await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("has_element"), from: item.id, to: media.id, confidence: "high", source: { kind: "manual" } } });
  await postIndicator(svc, u1, media.id, "hw_kind", { value: "storage" });
  const missing = async (who: string) => (await callAs(svc, who, "GET", `/api/cases/${c.id}`)).json().answered.missing as string[];
  assert.ok((await missing(h1)).some((m) => m.startsWith(media.id)), "до метки Наблюдатель видит Носитель");
  assert.ok(!(await missing(h1)).some((m) => m.endsWith("Имя хоста")));
  for (const id of [host.id, media.id]) assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/records/${id}/secret/mark`, { expectedVersion: 1 })).statusCode, 200);
  const observer = await missing(h1);
  assert.ok(!observer.some((m) => m.includes(media.id)), "Идентификатор Секрет-Носителя Наблюдателю не идёт");
  assert.ok(observer.some((m) => m.endsWith("Имя хоста")), "скрытый ответ Наблюдателю не засчитан");
  const member = await missing(u1);
  assert.ok(member.some((m) => m.startsWith(media.id)));
  assert.ok(!member.some((m) => m.endsWith("Имя хоста")));
});

test("T210, DICT-08: необязательное поле местного типа добавляется и в шаблон подтипа", async (t) => {
  const { proposeLocal } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const typeId = (await proposeLocal(svc, u1, "type", { code: "fc_note", label: "x", object: T.object("flight_profile"), format: "строка:64" })).json().resultId as string;
  const field = { class: "flight_controller", subtype: "bare_media", block: "class", label: "Заметка ПК", indicatorType: typeId };
  const accepted = await proposeLocal(svc, u1, "template_field", field);
  assert.equal(accepted.statusCode, 200, accepted.body);
  const labels = async (q: string) => (await form(svc, q)).blocks.flatMap((b) => b.fields.map((f) => f.label));
  assert.ok((await labels("class=flight_controller&subtype=bare_media")).includes("Заметка ПК"));
  assert.ok(!(await labels("class=flight_controller")).includes("Заметка ПК"), "поле подтипа — только в его шаблоне");
  assert.equal((await proposeLocal(svc, u1, "template_field", { ...field, subtype: "nope" }, false)).statusCode, 400);
});

test("T292, DATA-27: строка из нескольких полей программы отвечена, когда отвечено каждое поле", async (t) => {
  const { EV, createTestCase, createTestItem, createTestObject, postIndicator, testDictionaryDocument } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const doc = testDictionaryDocument({
    change: (b) => {
      const tpl = b.templates.find((x) => x.class === EV("item_class", "companion") && x.subtype === undefined)!;
      const media = tpl.blocks.find((x) => x.block === "media")!;
      tpl.blocks[tpl.blocks.indexOf(media)] = { ...media, fields: [...media.fields, { label: "Средство снятия, станция приёмки", required: true, defaultSource: "manual", target: { programField: "acquisitionTool,intakeStation" } }] };
    },
  });
  await applyTestDictionary(svc, signWithTestCoordinator(doc));
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const media = await createTestObject(svc, u1, "hw_element", { case: c.id, acquisitionTool: "dd 9.4" });
  await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("has_element"), from: item.id, to: media.id, confidence: "high", source: { kind: "manual" } } });
  await postIndicator(svc, u1, media.id, "hw_kind", { value: "storage" });
  const missing = async () => ((await callAs(svc, u1, "GET", `/api/cases/${c.id}`)).json().answered.missing as string[]).filter((m) => m.endsWith("станция приёмки"));
  assert.equal((await missing()).length, 1, "станция приёмки не указана — строка не отвечена");
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${media.id}`, { expectedVersion: 1, fields: { intakeStation: { state: "not_applicable" } } })).statusCode, 200);
  assert.equal((await missing()).length, 0);
});

test("T297, DATA-27: «отвечено» Кейса одно — view Записи Кейса совпадает со сводкой GET /api/cases/:id", async (t) => {
  const { createTestCase, createTestItem } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1, { seizedAt: "2026-01-01" });
  await createTestItem(svc, u1, c.id);
  const summary = (await callAs(svc, u1, "GET", `/api/cases/${c.id}`)).json();
  assert.equal(summary.answered.complete, false, "поля Изделия не отвечены");
  assert.deepEqual(summary.case.view.answered, summary.answered);
  assert.deepEqual((await callAs(svc, u1, "GET", `/api/records/${c.id}`)).json().view.answered, summary.answered);
});

test("T303, DATA-27: поле только с видом объекта отвечено, когда у Изделия есть объект этого вида", async (t) => {
  const { EV, createTestCase, createTestItem, createTestObject, testDictionaryDocument } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const doc = testDictionaryDocument({
    change: (b) => {
      const tpl = b.templates.find((x) => x.class === EV("item_class", "companion") && x.subtype === undefined)!;
      tpl.blocks.find((x) => x.block === "class")!.fields.push({ label: "Стек ПО", required: true, defaultSource: "manual", target: { objectKind: T.object("platform") } });
    },
  });
  await applyTestDictionary(svc, signWithTestCoordinator(doc));
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const missing = async () => ((await callAs(svc, u1, "GET", `/api/cases/${c.id}`)).json().answered.missing as string[]).filter((m) => m.endsWith("Стек ПО"));
  assert.equal((await missing()).length, 1, "объекта нет — поле не отвечено");
  await createTestObject(svc, u1, "platform", { item: item.id });
  assert.equal((await missing()).length, 0);
});
