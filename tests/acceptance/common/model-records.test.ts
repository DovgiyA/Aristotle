// T041 (часть «Кейс и Изделие») — Записи модели данных: Кейс и Изделие — разные Записи, Класс у
// Изделия, Борт — один Кейс, поля программы и закрытые перечни (DATA-01 … DATA-06, DATA-08,
// DATA-13 … DATA-17, DATA-19, DATA-20, DICT-60, BANK-20 … BANK-22, BANK-24, BANK-34, BANK-37).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
import { EV, T, applyTestDictionary, createTestCase, createTestItem, createTestObject, postIndicator } from "../../support/dictionary.ts";
import { getRecordType } from "@aristotel/core";

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("Кейс: UUIDv7 без значимых частей; draft; дата приёмки и исполнители по умолчанию", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  assert.match(c.id, UUID7);
  assert.equal(c.fields["status"], "draft");
  assert.equal(c.fields["receivedAt"], new Date().toISOString().slice(0, 10));
  assert.deepEqual(c.fields["performers"], [u1]);
  assert.doesNotMatch(c.id, new RegExp(String(c.fields["number"])));
});

test("до применения Словаря — 409 dictionary_missing", async (t) => {
  const svc = await startTestService(t);
  const res = await callAs(svc, svc.addMember("У1"), "POST", "/api/records", { type: "case", fields: {} });
  assert.deepEqual([res.statusCode, res.json().error], [409, "dictionary_missing"]);
});

test("закрытые перечни полей программы: shape и itemClass вне перечня — model_invalid; Класса «прочее» нет", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const bad = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: "x" } });
  assert.deepEqual([bad.statusCode, bad.json().error], [400, "model_invalid"]);
  const c = await createTestCase(svc, u1);
  const other = await callAs(svc, u1, "POST", "/api/records", { type: "item", fields: { case: c.id, itemClass: EV("os_distro", "debian") } });
  assert.equal(other.json().error, "model_invalid");
  assert.ok(Array.isArray(other.json().details.issues));
});

test("отдельное Изделие — одно; Борт — несколько Изделий разных Классов; Класс и подтип — у Изделия", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const single = await createTestCase(svc, u1);
  await createTestItem(svc, u1, single.id, "companion");
  const second = await callAs(svc, u1, "POST", "/api/records", { type: "item", fields: { case: single.id, itemClass: EV("item_class", "flight_controller") } });
  assert.equal(second.json().error, "model_invalid", "DATA-01: у отдельного Изделия ровно одно");
  const airframe = await createTestCase(svc, u1, { shape: EV("case_shape", "airframe") });
  const comp = await createTestItem(svc, u1, airframe.id, "companion");
  const fc = await createTestItem(svc, u1, airframe.id, "flight_controller", { itemSubtype: EV("item_subtype", "bare_media") });
  assert.equal(fc.fields["itemSubtype"], EV("item_subtype", "bare_media"));
  assert.notEqual(comp.fields["itemClass"], fc.fields["itemClass"]);
  assert.equal(airframe.fields["itemClass"], undefined, "Класса у Кейса нет (DATA-02)");
  const moved = await callAs(svc, u1, "PATCH", `/api/records/${comp.id}`, { expectedVersion: 1, fields: { case: single.id } });
  assert.equal(moved.json().error, "model_invalid", "Кейс Изделия не меняется");
});

test("Обозначение меняется с историей; Прежний идентификатор — только при создании; Идентификатор не меняется", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1, { legacyId: "CASE-x", designation: "x" });
  const renamed = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: 1, fields: { designation: "y" } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().id, c.id);
  assert.equal(renamed.json().fields["number"], c.fields["number"]);
  const history = (await callAs(svc, u1, "GET", `/api/records/${c.id}/history`)).json().items;
  assert.ok(history.some((h: { field: string; after: unknown }) => h.field === "designation" && h.after === "y"));
  const legacy = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: 2, fields: { legacyId: "CASE-y" } });
  assert.equal(legacy.json().error, "model_invalid");
  const late = await createTestCase(svc, u1);
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${late.id}`, { expectedVersion: 1, fields: { legacyId: "CASE-z" } })).json().error, "model_invalid");
});

test("поля «кто изъял или передал» нет; исполнители в пакеты не идут", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: EV("case_shape", "single_item"), seizedBy: "x" } });
  assert.equal(res.statusCode, 400, "DATA-20: лишнее поле — отказ");
  assert.equal(getRecordType("case")?.exchange?.["performers"], false, "DATA-21");
});

test("один_борт и соединено_с между Изделиями двух Кейсов — вместе и порознь; Кейсы не объединяются", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c1 = await createTestCase(svc, u1);
  const c2 = await createTestCase(svc, u1);
  const i1 = await createTestItem(svc, u1, c1.id, "companion");
  const i2 = await createTestItem(svc, u1, c2.id, "flight_controller");
  for (const code of ["same_airframe", "connected_to"]) {
    const link = await callAs(svc, u1, "POST", "/api/records", {
      type: "link",
      fields: { type: T.link(code), from: i1.id, to: i2.id, confidence: "high", source: { kind: "manual" }, case: c1.id },
    });
    assert.equal(link.statusCode, 201, link.body);
  }
  assert.notEqual((await callAs(svc, u1, "GET", `/api/records/${c1.id}`)).json().fields["number"], (await callAs(svc, u1, "GET", `/api/records/${c2.id}`)).json().fields["number"]);
});

// T047 (часть «Объекты, связи, Индикаторы») — DATA-09 … DATA-12, DATA-25 … DATA-30, DATA-36, DICT-14,
// DICT-37 … DICT-39, DICT-57, ROLE-25.

async function stand(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id, "companion");
  return { svc, u1, c, item };
}

test("узел без Изделия, часть Изделия — с Изделием; связь — уверенность обязательна, концы по «Между»", async (t) => {
  const { svc, u1, c, item } = await stand(t);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const part = await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: T.object("platform"), case: c.id } });
  assert.equal(part.json().error, "model_invalid", "часть Изделия без Изделия");
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  assert.equal(platform.fields["case"], c.id, "часть Изделия — в Кейсе своего Изделия");
  const link = (fields: Record<string, unknown>) => callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { source: { kind: "manual" }, ...fields } });
  assert.equal((await link({ type: T.link("authored_by"), from: item.id, to: op.id })).json().error, "model_invalid", "без уверенности (T135)");
  assert.equal((await link({ type: T.link("authored_by"), from: item.id, to: op.id, confidence: "x" })).statusCode, 400);
  const ok = await link({ type: T.link("authored_by"), from: item.id, to: op.id, confidence: "medium" });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().fields["author"], u1);
  assert.equal((await link({ type: T.link("uses_key"), from: item.id, to: op.id, confidence: "low" })).json().error, "model_invalid", "концы не по «Между»");
  const art = await createTestObject(svc, u1, "artifact", { case: c.id });
  assert.equal((await link({ type: T.link("supported_by"), from: ok.json().id, to: art.id, confidence: "high" })).statusCode, 201, "подтверждается — к Артефакту");
});

test("Индикатор: значение как введено, нормализованная форма по Классу; состояния пустого поля", async (t) => {
  const { svc, u1, c, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const host = await postIndicator(svc, u1, platform.id, "hostname", { value: "Host-1.Example.test" });
  assert.equal(host.statusCode, 201, host.body);
  assert.equal(host.json().fields["value"], "Host-1.Example.test");
  assert.equal(host.json().view.normalized, "host-1");
  assert.equal(host.json().fields["case"], c.id);
  assert.equal((await postIndicator(svc, u1, platform.id, "os_note", { state: "not_established" })).json().error, "model_invalid", "не установлено — с причиной");
  assert.equal((await postIndicator(svc, u1, platform.id, "os_note", { state: "not_established", reason: "x" })).statusCode, 201);
  for (const state of ["absent", "not_applicable"]) assert.equal((await postIndicator(svc, u1, platform.id, "os_note", { state })).statusCode, 201, state);
  assert.equal((await postIndicator(svc, u1, platform.id, "os_note", { value: "   " })).json().error, "model_invalid", "пустая строка — не значение");
});

test("метки: нарушение формата, вне Словаря, не нормализуется, не проверено", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const marks = async (type: string, value: Record<string, unknown>) => (await postIndicator(svc, u1, platform.id, type, value)).json().view.marks as string[];
  assert.deepEqual(await marks("hostname", { value: "x_y" }), ["format_violation", "not_normalizable"]);
  assert.deepEqual(await marks("os_distro", { value: "x" }), ["out_of_dictionary"]);
  assert.deepEqual(await marks("os_distro", { value: "debian" }), []);
  const auto = await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "x", file: "y" } });
  assert.deepEqual(auto.json().view.marks, ["unverified"]);
  assert.equal(auto.json().fields["verified"], false);
  assert.equal(auto.json().view.identifying, false, "hostname — не опознающий");
});

test("правка значения «авто» — с причиной; исходное значение видно рядом (DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const auto = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "x", file: "y" } })).json();
  const bad = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "y" } });
  assert.equal(bad.json().error, "model_invalid");
  const fixed = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason: "x" } } });
  assert.equal(fixed.statusCode, 200, fixed.body);
  assert.equal(fixed.json().view.autoValue, "x");
});

test("Индикатор типа с автоматическим Секретом создан сразу Секретом; Наблюдатель его не видит (ROLE-25)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const res = await postIndicator(svc, u1, platform.id, "recovered_password", { value: "x" });
  assert.equal(res.json().secret, true);
  assert.equal((await callAs(svc, svc.addMember("Н1", "observer"), "GET", `/api/records/${res.json().id}`)).statusCode, 404);
});

test("Кейс Индикатора по правилу R1: явный; единственный Кейс, связанный через Изделия; несколько или ни одного — 400 case_required (T084)", async (t) => {
  const { svc, u1, c, item } = await stand(t);
  const c2 = await createTestCase(svc, u1);
  const item2 = await createTestItem(svc, u1, c2.id);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const raw = (fields: Record<string, unknown>) =>
    callAs(svc, u1, "POST", "/api/records", { type: "indicator", fields: { object: op.id, type: T.indicator("username"), source: { kind: "manual" }, ...fields } });
  // Ни одного Изделия, связанного с узлом, — отказ (узел заведён из Кейса, но с ним не связан).
  assert.deepEqual([(await raw({ value: "x" })).statusCode, (await raw({ value: "x" })).json().error], [400, "case_required"]);
  const link = (from: string) => callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from, to: op.id, confidence: "high", source: { kind: "manual" } } });
  assert.equal((await link(item.id)).statusCode, 201);
  assert.equal((await raw({ value: "x" })).json().fields["case"], c.id, "единственный связанный Кейс");
  assert.equal((await link(item2.id)).statusCode, 201);
  const several = await raw({ value: "y" });
  assert.deepEqual([several.statusCode, several.json().error], [400, "case_required"], "общий узел двух Кейсов");
  assert.equal((await raw({ value: "y", case: c2.id })).json().fields["case"], c2.id, "внесённый с Карточки другого Кейса — к нему");
  const loose = await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: T.object("key") } });
  assert.deepEqual([loose.statusCode, loose.json().error], [400, "case_required"]);
});

test("значение, ставшее нормализуемым после правки, теряет метку (Edge Cases)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const bad = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x_y" })).json();
  const fixed = await callAs(svc, u1, "PATCH", `/api/records/${bad.id}`, { expectedVersion: 1, fields: { value: "x-y" } });
  assert.deepEqual(fixed.json().view.marks, []);
  assert.equal(fixed.json().view.normalized, "x-y");
});

// Phase 14: Convergence — T096 … T098, T103, T107 … T109, T112.

test("T096: правка заменяет значение состоянием пустого поля и обратно (DATA-26, DATA-27)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const unknown = (await postIndicator(svc, u1, platform.id, "os_note", { state: "not_established", reason: "x" })).json();
  const found = await callAs(svc, u1, "PATCH", `/api/records/${unknown.id}`, { expectedVersion: 1, fields: { value: "y" } });
  assert.equal(found.statusCode, 200, found.body);
  assert.equal(found.json().fields["value"], "y");
  assert.equal(found.json().fields["state"], undefined);
  assert.equal(found.json().fields["reason"], undefined, "причина «не установлено» уходит вместе с состоянием");
  const absent = await callAs(svc, u1, "PATCH", `/api/records/${unknown.id}`, { expectedVersion: 2, fields: { state: "absent" } });
  assert.equal(absent.statusCode, 200, absent.body);
  assert.deepEqual([absent.json().fields["value"], absent.json().fields["state"]], [undefined, "absent"]);
  const both = await callAs(svc, u1, "PATCH", `/api/records/${unknown.id}`, { expectedVersion: 3, fields: { value: "z", state: "not_applicable" } });
  assert.equal(both.json().error, "model_invalid", "значение и состояние сразу — отказ");
});

test("T097: verified ставит программа — клиент его не задаёт ни при создании, ни правкой (DATA-29)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const auto = { kind: "auto", parser: "x", file: "y" };
  assert.equal((await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: auto, verified: true })).json().error, "model_invalid");
  const created = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: auto })).json();
  assert.deepEqual(created.view.marks, ["unverified"]);
  const flip = await callAs(svc, u1, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { verified: true } });
  assert.equal(flip.json().error, "model_invalid");
});

test("T098: исходное значение «авто» ставит программа — подделать нельзя (DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  assert.equal((await postIndicator(svc, u1, platform.id, "hostname", { value: "x", autoValue: "y" })).json().error, "model_invalid");
  const auto = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "x", file: "y" } })).json();
  const fake = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason: "x" }, autoValue: "z" } });
  assert.equal(fake.json().error, "model_invalid");
  const fixed = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason: "x" } } });
  assert.equal(fixed.json().view.autoValue, "x");
});

test("T103: «Район изъятия» — Гео-объект (DATA-16)", async (t) => {
  const { svc, u1, c } = await stand(t);
  const geo = await createTestObject(svc, u1, "geo_object", { case: c.id });
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const set = (v: string, version: number) => callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: version, fields: { seizureArea: v } });
  assert.equal((await set("x", 1)).json().error, "model_invalid", "не Запись");
  assert.equal((await set(op.id, 1)).json().error, "model_invalid", "не Гео-объект");
  assert.equal((await set(geo.id, 1)).statusCode, 200);
});

test("T107: поля блока «Носитель» — только у Аппаратного элемента; средство и станция — строки", async (t) => {
  const { svc, u1, c } = await stand(t);
  const op = await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: T.object("operator"), case: c.id, acquisitionTool: "x" } });
  assert.equal(op.json().error, "model_invalid");
  const hw = await callAs(svc, u1, "POST", "/api/records", {
    type: "object",
    fields: { kind: T.object("hw_element"), case: c.id, acquisitionMethod: EV("acquisition_method", "logical"), acquisitionTool: "x 1.0", intakeStation: "y", extractionStatus: EV("extraction_status", "full") },
  });
  assert.equal(hw.statusCode, 201, hw.body);
});

test("T108: дата приёмки — одна дата; причина «не установлено» в общей части — не из пробелов (DATA-15, DATA-26)", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const range = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { receivedAt: "2026-01-01/2026-01-02" } });
  assert.equal(range.json().error, "model_invalid");
  const blank = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { seizedAt: { state: "not_established", reason: "   " } } });
  assert.equal(blank.json().error, "model_invalid");
  assert.equal((await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { seizedAt: "2026-01-01/2026-01-02" } })).statusCode, 201, "дата изъятия — можно диапазоном");
});

test("T109: Кейс связи не меняется правкой (DATA-36)", async (t) => {
  const { svc, u1, c, item } = await stand(t);
  const c2 = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const link = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: item.id, to: op.id, confidence: "high", source: { kind: "manual" } } })).json();
  const moved = await callAs(svc, u1, "PATCH", `/api/records/${link.id}`, { expectedVersion: 1, fields: { case: c2.id } });
  assert.equal(moved.json().error, "model_invalid");
});

test("T112: пометка «исполнители не уходят в пакеты» — поле типа Записи (DATA-21)", () => {
  assert.equal(getRecordType("case")?.exchange?.["performers"], false);
});

// Phase 15: Convergence — T120, T125, T127, T132 … T137.

test("T120: правка «авто»-Индикатора с состоянием пустого поля — с причиной, исходное состояние рядом, без 500 (DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const auto = (await postIndicator(svc, u1, platform.id, "os_note", { state: "not_established", reason: "x", source: { kind: "auto", program: "p" } })).json();
  const noReason = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "v" } });
  assert.equal(noReason.json().error, "model_invalid");
  const fixed = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "v", correction: { reason: "r" } } });
  assert.equal(fixed.statusCode, 200, fixed.body);
  assert.deepEqual(fixed.json().view.autoState, { state: "not_established", reason: "x" });
  assert.equal(fixed.json().view.autoValue, null);
});

test("T125: источник ставит программа — клиент его не меняет; смена состояния «авто» — правка с причиной (DATA-29, DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const auto = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "x", file: "y" } })).json();
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { source: { kind: "manual" } } })).json().error, "model_invalid");
  const manual = (await postIndicator(svc, u1, platform.id, "hostname", { value: "y" })).json();
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${manual.id}`, { expectedVersion: 1, fields: { source: { kind: "auto", program: "p" } } })).json().error, "model_invalid");
  const absent = (await postIndicator(svc, u1, platform.id, "os_note", { state: "absent", source: { kind: "auto", program: "p" } })).json();
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${absent.id}`, { expectedVersion: 1, fields: { state: "not_applicable" } })).json().error, "model_invalid", "без причины");
  const changed = await callAs(svc, u1, "PATCH", `/api/records/${absent.id}`, { expectedVersion: 1, fields: { state: "not_applicable", correction: { reason: "r" } } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().fields["source"].kind, "manual");
  assert.deepEqual(changed.json().view.autoState, { state: "absent" });
});

test("T132: correction — только с правкой «авто»; причина «не установлено» уходит вместе с состоянием (DATA-26, DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  assert.equal((await postIndicator(svc, u1, platform.id, "os_note", { value: "x", correction: { reason: "r" } })).json().error, "model_invalid", "при создании");
  const manual = (await postIndicator(svc, u1, platform.id, "os_note", { value: "x" })).json();
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${manual.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason: "r" } } })).json().error, "model_invalid", "у ручного значения");
  const unknown = (await postIndicator(svc, u1, platform.id, "os_note", { state: "not_established", reason: "x" })).json();
  const absent = await callAs(svc, u1, "PATCH", `/api/records/${unknown.id}`, { expectedVersion: 1, fields: { state: "absent" } });
  assert.equal(absent.statusCode, 200, absent.body);
  assert.equal(absent.json().fields["reason"], undefined);
  const auto = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "x", file: "y" } })).json();
  const fixed = (await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason: "r" } } })).json();
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: fixed.version, fields: { correction: { reason: "переписано" } } })).json().error, "model_invalid", "причину правки не переписать");
});

test("T133: исправленное человеком значение «авто» — проверено: verified = true, метки нет (DATA-29, DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const auto = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "x", file: "y" } })).json();
  const fixed = (await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason: "r" } } })).json();
  assert.equal(fixed.fields["verified"], true);
  assert.deepEqual(fixed.view.marks, []);
  assert.equal(fixed.view.autoValue, "x");
});

test("T127: обязательные поля программы принимают состояния пустого поля (DATA-26, DATA-27)", async (t) => {
  const { svc, u1, c } = await stand(t);
  const shape = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: { state: "not_established", reason: "неизвестно" } } });
  assert.equal(shape.statusCode, 201, shape.body);
  assert.ok(!shape.json().view.answered.missing.includes("shape"), "состояние — ответ");
  assert.equal((await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: { state: "not_established" } } })).json().error, "model_invalid", "без причины");
  const hw = await callAs(svc, u1, "POST", "/api/records", {
    type: "object",
    fields: { kind: T.object("hw_element"), case: c.id, acquisitionMethod: { state: "absent" }, intakeStation: { state: "not_established", reason: "приёмка до v2" } },
  });
  assert.equal(hw.statusCode, 201, hw.body);
});

test("T134: поля «Носителя» у Аппаратного элемента, не носителя по hw_kind, — отказ", async (t) => {
  const { svc, u1, c } = await stand(t);
  const hw = await createTestObject(svc, u1, "hw_element", { case: c.id });
  await postIndicator(svc, u1, hw.id, "hw_kind", { value: "sbc", case: c.id });
  const res = await callAs(svc, u1, "PATCH", `/api/records/${hw.id}`, { expectedVersion: 1, fields: { extractionStatus: EV("extraction_status", "full") } });
  assert.equal(res.json().error, "model_invalid");
});

test("T135: лишнее поле Записи модели — 400 model_invalid с details.issues (DATA-20)", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { seizedBy: "x" } });
  assert.deepEqual([res.statusCode, res.json().error], [400, "model_invalid"]);
  assert.ok(res.json().details.issues.some((i: { field: string }) => i.field === "seizedBy"));
});

test("T136: Наблюдатель не исполнитель Кейса (DATA-19)", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  assert.equal((await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { performers: [h1] } })).json().error, "model_invalid");
  assert.equal((await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { performers: [u1, svc.seniorId] } })).statusCode, 201);
});

test("T137: часть Изделия — в Кейсе своего Изделия, другой case — отказ (DATA-10, DATA-36)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const c2 = await createTestCase(svc, u1);
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: T.object("platform"), item: item.id, case: c2.id } });
  assert.equal(res.json().error, "model_invalid");
});

test("T128: точность Района изъятия — в значении «гео» Гео-объекта, из перечня geo_precision (DATA-16)", async (t) => {
  const { svc, u1, c } = await stand(t);
  const geo = await createTestObject(svc, u1, "geo_object", { case: c.id });
  assert.deepEqual((await postIndicator(svc, u1, geo.id, "geo_shape", { value: "1.5,2.5 district", case: c.id })).json().view.marks, []);
  assert.deepEqual((await postIndicator(svc, u1, geo.id, "geo_shape", { value: "1.5,2.5 km_99", case: c.id })).json().view.marks, ["out_of_dictionary"], "T148: перечень открытый");
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: 1, fields: { seizureArea: geo.id } })).statusCode, 200);
});

// Phase 16: Convergence — T144, T145, T149 … T153.

test("T144: performers не массив — model_invalid, а не 500", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  for (const performers of [5, {}]) assert.equal((await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { performers } })).json().error, "model_invalid", JSON.stringify(performers));
});

test("T145: нет обязательного поля — его имя в details.issues с правилом field", async (t) => {
  const { svc, u1, c, item } = await stand(t);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: item.id, to: op.id, source: { kind: "manual" } } });
  assert.equal(res.json().error, "model_invalid");
  assert.ok(res.json().details.issues.some((i: { field: string; rule: string }) => i.field === "confidence" && i.rule === "field"), res.body);
});

test("T149: неизменённый correction в правке не отклоняется (GET → PATCH; DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const auto = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "x", file: "y" } })).json();
  const fixed = (await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason: "r" } } })).json();
  const roundtrip = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: fixed.version, fields: { ...fixed.fields, note: "n" } });
  assert.equal(roundtrip.statusCode, 200, roundtrip.body);
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: roundtrip.json().version, fields: { correction: { reason: "r" } } })).statusCode, 200);
});

test("T150: hw_kind не носитель на элементе с полями «Носителя» — отказ; объект остаётся правимым", async (t) => {
  const { svc, u1, c } = await stand(t);
  const hw = (await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: T.object("hw_element"), case: c.id, intakeStation: "x" } })).json();
  assert.equal((await postIndicator(svc, u1, hw.id, "hw_kind", { value: "sbc", case: c.id })).json().error, "model_invalid");
  const storage = (await postIndicator(svc, u1, hw.id, "hw_kind", { value: "storage", case: c.id })).json();
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${storage.id}`, { expectedVersion: 1, fields: { value: "sbc" } })).json().error, "model_invalid");
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${hw.id}`, { expectedVersion: 1, fields: { intakeStation: "y" } })).statusCode, 200);
});

test("T151: правка человеком значения «агент» или «импорт» и смена причины «авто» — правка с причиной (DATA-28, DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  for (const source of [{ kind: "agent", client: "c", model: "m", version: "1", assignment: "a" }, { kind: "import", unit: "u" }]) {
    const v = (await postIndicator(svc, u1, platform.id, "os_note", { value: "x", source })).json();
    assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${v.id}`, { expectedVersion: 1, fields: { value: "y" } })).json().error, "model_invalid", source.kind);
    const fixed = (await callAs(svc, u1, "PATCH", `/api/records/${v.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason: "r" } } })).json();
    assert.deepEqual([fixed.fields["source"].kind, fixed.view.autoValue], ["manual", "x"], source.kind);
  }
  const auto = (await postIndicator(svc, u1, platform.id, "os_note", { state: "not_established", reason: "a", source: { kind: "auto", program: "p" } })).json();
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { reason: "b" } })).json().error, "model_invalid");
  const reason = (await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { reason: "b", correction: { reason: "r" } } })).json();
  assert.deepEqual(reason.view.autoState, { state: "not_established", reason: "a" });
});

test("T152: одно правило пустого поля — причина только у «не установлено», пробелы — не значение (DATA-26)", async (t) => {
  const { svc, u1, c } = await stand(t);
  const shape = (await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: { state: "absent", reason: "x" } } })).json();
  assert.deepEqual(shape.fields["shape"], { state: "absent" });
  const blank = await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: T.object("hw_element"), case: c.id, acquisitionTool: "   " } });
  assert.equal(blank.json().error, "model_invalid");
});

test("T153: исполнитель, ставший Наблюдателем, не блокирует правку; новый исполнитель-Наблюдатель — своё правило", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  const c = (await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { performers: [u1, u2] } })).json();
  svc.db.prepare("UPDATE member SET role = 'observer' WHERE id = ?").run(u2);
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: 1, fields: { designation: "x" } })).statusCode, 200);
  const h = svc.addMember("Н1", "observer");
  const res = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: 2, fields: { performers: [u1, h] } });
  assert.ok(res.json().details.issues.some((i: { field: string; rule: string }) => i.field === "performers" && i.rule === "observer"), res.body);
});

test("T164: «тот же» — по структуре: source и correction с ключами в другом порядке — не правка программы (DATA-30)", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const auto = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "p", file: "f" } })).json();
  const reordered = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { source: { file: "f", parser: "p", kind: "auto" }, note: "n" } });
  assert.equal(reordered.statusCode, 200, reordered.body);
  const unknown = (await postIndicator(svc, u1, platform.id, "os_note", { state: "not_established", reason: "a", source: { kind: "auto", program: "p" } })).json();
  const fixed = (await callAs(svc, u1, "PATCH", `/api/records/${unknown.id}`, { expectedVersion: 1, fields: { value: "v", correction: { reason: "r" } } })).json();
  const autoState = fixed.fields["autoState"] as { state: string; reason: string };
  const back = await callAs(svc, u1, "PATCH", `/api/records/${unknown.id}`, { expectedVersion: fixed.version, fields: { autoState: { reason: autoState.reason, state: autoState.state }, note: "n" } });
  assert.equal(back.statusCode, 200, back.body);
});

test("T170, DATA-30: correction.reason не строкой — model_invalid, а не 500", async (t) => {
  const { svc, u1, item } = await stand(t);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const auto = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x", source: { kind: "auto", parser: "p", file: "f" } })).json();
  for (const reason of [5, null, ["a"]]) {
    const res = await callAs(svc, u1, "PATCH", `/api/records/${auto.id}`, { expectedVersion: 1, fields: { value: "y", correction: { reason } } });
    assert.deepEqual([res.statusCode, res.json().error], [400, "model_invalid"], JSON.stringify(reason));
  }
});

test("T178, FR-009: from, to и object не строкой (объект с испорченным toString) — model_invalid, а не 500", async (t) => {
  const { svc, u1, c, item } = await stand(t);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const bad = { toString: 1 };
  const link = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: bad, to: op.id, confidence: "high", source: { kind: "manual" }, case: c.id } });
  assert.deepEqual([link.statusCode, link.json().error], [400, "model_invalid"], link.body);
  void item;
  const ind = await callAs(svc, u1, "POST", "/api/records", { type: "indicator", fields: { object: bad, type: T.indicator("hw_kind"), value: "board", source: { kind: "manual" }, case: c.id } });
  assert.deepEqual([ind.statusCode, ind.json().error], [400, "model_invalid"], ind.body);
});

test("T191, DICT-12: концы связи — по канону: после склейки вида объекта связи создаются и правятся", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const radio = await createTestObject(svc, u1, "radio", { case: c.id });
  const old = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("links_via"), from: item.id, to: radio.id, confidence: "low", source: { kind: "manual" } } })).json();
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.object("radio"))!;
      el.state = "absorbed";
      el.canonical = T.object("infra_node");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
      b.elements.find((e) => e.id === T.link("links_via"))!.props["to"] = [T.object("infra_node")];
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const fresh = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("controlled_via"), from: item.id, to: radio.id, confidence: "high", source: { kind: "manual" } } });
  assert.equal(fresh.statusCode, 201, fresh.body);
  const patched = await callAs(svc, u1, "PATCH", `/api/records/${old.id}`, { expectedVersion: 1, fields: { confidence: "high" } });
  assert.equal(patched.statusCode, 200, patched.body);
});

test("T196, DICT-12: «Между» связи поглощённого типа — у канонического типа связи", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const key = await createTestObject(svc, u1, "key", { case: c.id });
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.link("built_on"))!;
      el.state = "absorbed";
      el.canonical = T.link("uses_key");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const link = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("built_on"), from: item.id, to: key.id, confidence: "high", source: { kind: "manual" } } });
  assert.equal(link.statusCode, 201, link.body);
});

test("T202, DICT-37: строковые поля Записей модели — правильно построенный Юникод, иначе model_invalid", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  for (const fields of [{ value: "x\ud800" }, { value: "x", note: "\udc00y" }]) {
    const res = await postIndicator(svc, u1, op.id, "callsign", fields);
    assert.deepEqual([res.statusCode, res.json().error], [400, "model_invalid"], `${JSON.stringify(fields)}: ${res.body}`);
  }
  const ok = (await postIndicator(svc, u1, op.id, "callsign", { value: "x" })).json();
  const patched = await callAs(svc, u1, "PATCH", `/api/records/${ok.id}`, { expectedVersion: 1, fields: { value: "\ud83dy" } });
  assert.deepEqual([patched.statusCode, patched.json().error], [400, "model_invalid"], patched.body);
  for (const fields of [{ designation: "a\ud800" }, { report: "\udfff" }]) {
    const res = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: c.version, fields });
    assert.deepEqual([res.statusCode, res.json().error], [400, "model_invalid"], `${JSON.stringify(fields)}: ${res.body}`);
  }
});

test("T192, DICT-13: новый объект и связь через поглощённый вид, чей канон устарел, — deprecated", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const station = await createTestObject(svc, u1, "build_station", { case: c.id });
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      for (const [from, to] of [[T.link("uses_key"), T.link("built_on")], [T.object("key"), T.object("build_station")]] as const) {
        const el = b.elements.find((e) => e.id === from)!;
        el.state = "absorbed";
        el.canonical = to;
        b.merges.push({ absorbed: from, canonical: to });
        b.elements.find((e) => e.id === to)!.state = "deprecated";
      }
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const obj = await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: T.object("key"), case: c.id } });
  assert.equal(obj.json().error, "model_invalid", obj.body);
  const link = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("uses_key"), from: item.id, to: station.id, confidence: "low", source: { kind: "manual" } } });
  assert.equal(link.json().error, "model_invalid", link.body);
});

test("T207, DICT-13: правка связи на устаревший тип — model_invalid, как создание", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1, { shape: EV("case_shape", "airframe") });
  const a = await createTestItem(svc, u1, c.id);
  const b = await createTestItem(svc, u1, c.id);
  const link = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("same_airframe"), from: a.id, to: b.id, confidence: "high", source: { kind: "manual" } } })).json();
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (body) => (body.elements.find((e) => e.id === T.link("connected_to"))!.state = "deprecated")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const res = await callAs(svc, u1, "PATCH", `/api/records/${link.id}`, { expectedVersion: 1, fields: { type: T.link("connected_to") } });
  assert.deepEqual([res.statusCode, res.json().error], [400, "model_invalid"], res.body);
  assert.ok((res.json().details.issues as { rule: string }[]).some((i) => i.rule === "deprecated"));
});

test("T208, DATA-13: hw_kind «storage » с пробелом — носитель, как его видит проверка формата", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id, "flight_controller");
  const media = await createTestObject(svc, u1, "hw_element", { case: c.id });
  await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("has_element"), from: item.id, to: media.id, confidence: "high", source: { kind: "manual" } } });
  const kind = await postIndicator(svc, u1, media.id, "hw_kind", { value: "storage " });
  assert.deepEqual([kind.statusCode, kind.json().view.marks], [201, []], kind.body);
  const missing = (await callAs(svc, u1, "GET", `/api/cases/${c.id}`)).json().answered.missing as string[];
  assert.ok(missing.some((m) => m.startsWith(media.id) && m.endsWith("Способ снятия")), "блок «Носитель» спрошен");
  const patched = await callAs(svc, u1, "PATCH", `/api/records/${media.id}`, { expectedVersion: 1, fields: { acquisitionMethod: EV("acquisition_method", "logical") } });
  assert.equal(patched.statusCode, 200, patched.body);
});

test("T212, DATA-02: радиомодуль с onLinux меняет Класс правкой — onLinux снимается null", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id, "radio_module", { onLinux: true });
  const kept = await callAs(svc, u1, "PATCH", `/api/records/${item.id}`, { expectedVersion: 1, fields: { itemClass: EV("item_class", "companion") } });
  assert.equal(kept.statusCode, 400, "onLinux у не-радиомодуля по-прежнему отказ");
  const res = await callAs(svc, u1, "PATCH", `/api/records/${item.id}`, { expectedVersion: 1, fields: { itemClass: EV("item_class", "companion"), onLinux: null } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().fields.onLinux, undefined);
});

test("T213, DATA-36: явный чужой Кейс у Индикатора части и у связи от Изделия — отказ, как у части", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c1 = await createTestCase(svc, u1);
  const c2 = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c1.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const ind = await postIndicator(svc, u1, platform.id, "hostname", { value: "h", case: c2.id });
  assert.deepEqual([ind.statusCode, ind.json().error], [400, "model_invalid"], ind.body);
  const station = await createTestObject(svc, u1, "build_station", { case: c1.id });
  const link = (caseId: string) => callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("built_on"), from: item.id, to: station.id, confidence: "high", source: { kind: "manual" }, case: caseId } });
  const foreign = await link(c2.id);
  assert.deepEqual([foreign.statusCode, foreign.json().error], [400, "model_invalid"], foreign.body);
  assert.equal((await link(c1.id)).statusCode, 201);
  assert.equal((await postIndicator(svc, u1, platform.id, "hostname", { value: "h", case: c1.id })).statusCode, 201);
});

test("T222, AGENT-08: значение от Агента — «не проверено»", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const res = await postIndicator(svc, u1, op.id, "callsign", { value: "x", source: { kind: "agent", client: "c", model: "m", version: "1", assignment: "a" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().fields.verified, false);
  assert.deepEqual(res.json().view.marks, ["unverified"]);
});

test("T226, DATA-11: source связи после создания ставит программа, author не меняется правкой", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const station = await createTestObject(svc, u1, "build_station", { case: c.id });
  const link = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("built_on"), from: item.id, to: station.id, confidence: "high", source: { kind: "auto", program: "p" } } })).json();
  for (const fields of [{ source: { kind: "manual" } }, { author: u2 }]) {
    const res = await callAs(svc, u1, "PATCH", `/api/records/${link.id}`, { expectedVersion: 1, fields });
    assert.deepEqual([res.statusCode, res.json().error], [400, "model_invalid"], `${JSON.stringify(fields)}: ${res.body}`);
  }
  // Тот же source (порядок ключей другой) — не правка источника; правка «авто» человеком — с причиной (T251).
  const same = await callAs(svc, u1, "PATCH", `/api/records/${link.id}`, { expectedVersion: 1, fields: { confidence: "low", source: { program: "p", kind: "auto" }, correction: { reason: "сверено" } } });
  assert.equal(same.statusCode, 200, same.body);
});

test("T227, DATA-36: связь от части Изделия без case — Кейс Изделия, как от самого Изделия", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c1 = await createTestCase(svc, u1);
  const c2 = await createTestCase(svc, u1);
  const item1 = await createTestItem(svc, u1, c1.id, "flight_controller");
  const item2 = await createTestItem(svc, u1, c2.id);
  const profile = await createTestObject(svc, u1, "flight_profile", { item: item1.id });
  const op = await createTestObject(svc, u1, "operator", { case: c2.id });
  const link = (from: string) => callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from, to: op.id, confidence: "high", source: { kind: "manual" } } });
  assert.equal((await link(item2.id)).statusCode, 201);
  const res = await link(profile.id);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().fields.case, c1.id);
});

test("T237, AGENT-08: связь с источником «авто» или «агент» — метка «не проверено»", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const station = await createTestObject(svc, u1, "build_station", { case: c.id });
  const marks = async (source: Record<string, unknown>) =>
    (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("built_on"), from: item.id, to: station.id, confidence: "high", source } })).json().view.marks;
  assert.deepEqual(await marks({ kind: "agent", client: "c", model: "m", version: "1", assignment: "a" }), ["unverified"]);
  assert.deepEqual(await marks({ kind: "auto", program: "p" }), ["unverified"]);
  assert.deepEqual(await marks({ kind: "manual" }), []);
});

test("T243, DATA-36: Индикатор узла, связанного только с частью Изделия, без case — Кейс этого Изделия", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id, "flight_controller");
  const profile = await createTestObject(svc, u1, "flight_profile", { item: item.id });
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  assert.equal((await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: profile.id, to: op.id, confidence: "high", source: { kind: "manual" } } })).statusCode, 201);
  const ind = await callAs(svc, u1, "POST", "/api/records", { type: "indicator", fields: { object: op.id, type: T.indicator("username"), value: "ivan", source: { kind: "manual" } } });
  assert.equal(ind.statusCode, 201, ind.body);
  assert.equal(ind.json().fields.case, c.id);
});

test("T246, DICT-13: прежние связь и Индикатор правятся после версии, сменившей «Между» и object типа", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const link = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: item.id, to: op.id, confidence: "low", source: { kind: "manual" } } })).json();
  const ind = (await postIndicator(svc, u1, op.id, "callsign", { value: "x" })).json();
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      b.elements.find((e) => e.id === T.link("authored_by"))!.props["to"] = [T.object("key")];
      b.elements.find((e) => e.id === T.indicator("callsign"))!.props["object"] = T.object("key");
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const l = await callAs(svc, u1, "PATCH", `/api/records/${link.id}`, { expectedVersion: 1, fields: { confidence: "high" } });
  assert.equal(l.statusCode, 200, l.body);
  const i = await callAs(svc, u1, "PATCH", `/api/records/${ind.id}`, { expectedVersion: ind.version, fields: { note: "n" } });
  assert.equal(i.statusCode, 200, i.body);
  const fresh = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: item.id, to: op.id, confidence: "low", source: { kind: "manual" } } });
  assert.equal(fresh.json().error, "model_invalid", "новая связь — по новому «Между»");
});

test("T251, DATA-30: правка человеком связи «агента» — источник «вручную», нужна причина", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const station = await createTestObject(svc, u1, "build_station", { case: c.id });
  const link = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("built_on"), from: item.id, to: station.id, confidence: "low", source: { kind: "agent", client: "c", model: "m", version: "1", assignment: "a" } } })).json();
  const noReason = await callAs(svc, u1, "PATCH", `/api/records/${link.id}`, { expectedVersion: 1, fields: { confidence: "high" } });
  assert.deepEqual([noReason.statusCode, noReason.json().error], [400, "model_invalid"], noReason.body);
  const res = await callAs(svc, u1, "PATCH", `/api/records/${link.id}`, { expectedVersion: 1, fields: { confidence: "high", correction: { reason: "проверено по снимку" } } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().fields.source, { kind: "manual" });
  assert.deepEqual(res.json().view.marks, []);
});

test("T252, DATA-19: отозванный Член Группы — не исполнитель Кейса и не автор связи", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const gone = svc.addMember("У2");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const station = await createTestObject(svc, u1, "build_station", { case: c.id });
  const old = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("built_on"), from: item.id, to: station.id, confidence: "low", source: { kind: "manual" }, author: gone } })).json();
  svc.db.prepare("UPDATE member SET state = 'revoked' WHERE id = ?").run(gone);
  const cs = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: EV("case_shape", "single_item"), performers: [gone] } });
  assert.deepEqual([cs.statusCode, cs.json().error], [400, "model_invalid"], cs.body);
  const link = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("built_on"), from: item.id, to: station.id, confidence: "low", source: { kind: "manual" }, author: gone } });
  assert.deepEqual([link.statusCode, link.json().error], [400, "model_invalid"], link.body);
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${old.id}`, { expectedVersion: 1, fields: { confidence: "high" } })).statusCode, 200, "прежняя связь отозванного автора правится");
});

test("T255, T178: case не строкой у Индикатора части и связи от Изделия — model_invalid, а не 500", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const bad = { toString: 1 };
  const ind = await callAs(svc, u1, "POST", "/api/records", { type: "indicator", fields: { object: platform.id, type: T.indicator("hostname"), value: "h", source: { kind: "manual" }, case: bad } });
  assert.deepEqual([ind.statusCode, ind.json().error], [400, "model_invalid"], ind.body);
  const link = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: item.id, to: op.id, confidence: "high", source: { kind: "manual" }, case: bad } });
  assert.deepEqual([link.statusCode, link.json().error], [400, "model_invalid"], link.body);
});

test("T257, BANK-07: снятое программой поле пишется в историю строкой снятия", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id, "radio_module", { onLinux: true });
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const ind = (await postIndicator(svc, u1, platform.id, "hostname", { value: "host-a" })).json();
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${ind.id}`, { expectedVersion: 1, fields: { state: "absent" } })).statusCode, 200);
  const history = async (id: string) => (await callAs(svc, u1, "GET", `/api/records/${id}/history`)).json().items as { version: number; field: string; before: unknown; after: unknown }[];
  const removed = (await history(ind.id)).find((h) => h.version === 2 && h.field === "value");
  assert.deepEqual([removed?.before, removed?.after], ["host-a", null], "значение снято — строка в истории");
  assert.equal((await callAs(svc, u1, "PATCH", `/api/records/${item.id}`, { expectedVersion: 1, fields: { onLinux: null } })).statusCode, 200);
  const onLinux = (await history(item.id)).filter((h) => h.version === 2);
  assert.deepEqual(onLinux.map((h) => [h.field, h.before, h.after]), [["onLinux", true, null]]);
});

test("T259, DICT-10: смена Кода значения перечня с синонимом — прежние Индикаторы не «вне Словаря»", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const ind = (await postIndicator(svc, u1, platform.id, "os_distro", { value: "debian" })).json();
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      b.elements.find((e) => e.id === EV("os_distro", "debian"))!.code = "debian_gnu";
      b.elements.find((e) => e.id === T.enumOf("os_distro"))!.props["aliases"] = { debian: "debian_gnu" };
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  assert.deepEqual((await callAs(svc, u1, "GET", `/api/records/${ind.id}`)).json().view.marks, []);
});

test("T263, DICT-13: у Индикатора устаревшего типа значение снимается, как меняется состояние", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const ind = (await postIndicator(svc, u1, platform.id, "os_note", { value: "x" })).json();
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => (b.elements.find((e) => e.id === T.indicator("os_note"))!.state = "deprecated")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const res = await callAs(svc, u1, "PATCH", `/api/records/${ind.id}`, { expectedVersion: 1, fields: { state: "not_applicable" } });
  assert.equal(res.statusCode, 200, res.body);
  const again = await callAs(svc, u1, "PATCH", `/api/records/${ind.id}`, { expectedVersion: 2, fields: { value: "y" } });
  assert.equal(again.json().error, "model_invalid", "новое значение по устаревшему типу — отказ");
});

test("T267, BANK-07: null у отсутствующего поля — не изменение; legacyId после создания не пишется", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  for (const fields of [{ legacyId: null }, { seizureArea: null }]) {
    const res = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: c.version, fields });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().version, c.version, `${JSON.stringify(fields)}: версия не меняется`);
  }
  const history = (await callAs(svc, u1, "GET", `/api/records/${c.id}/history`)).json().items as { before: unknown; after: unknown }[];
  assert.ok(!history.some((h) => h.before === null && h.after === null), "строк «было null — стало null» нет");
  const legacy = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: c.version, fields: { legacyId: "ОЛД-1" } });
  assert.equal(legacy.json().error, "model_invalid", "legacyId — только при создании");
});

test("T269, DATA-26: «строка из пробелов» и «носитель» — по одному правилу пробелов с проверкой формата", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const blank = await postIndicator(svc, u1, op.id, "callsign", { value: "\u0085" });
  assert.deepEqual([blank.statusCode, blank.json().error], [400, "model_invalid"], blank.body);
  const media = await createTestObject(svc, u1, "hw_element", { case: c.id, acquisitionMethod: EV("acquisition_method", "logical") });
  const kind = await postIndicator(svc, u1, media.id, "hw_kind", { value: "storage\u0085" });
  assert.equal(kind.statusCode, 201, kind.body);
  const tool = await callAs(svc, u1, "PATCH", `/api/records/${media.id}`, { expectedVersion: 1, fields: { acquisitionTool: "\u0085" } });
  assert.equal(tool.json().error, "model_invalid", "поле программы из пробелов — не значение");
});

test("T276, T267: null у отсутствующего поля снимается до проверок — ничего не стирает и не отказывает", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const ind = (await postIndicator(svc, u1, op.id, "callsign", { value: "ALPHA" })).json();
  const st = (await postIndicator(svc, u1, op.id, "username", { state: "not_established", reason: "r" })).json();
  const patch = (id: string, version: number, fields: Record<string, unknown>) => callAs(svc, u1, "PATCH", `/api/records/${id}`, { expectedVersion: version, fields });
  for (const [id, version, fields] of [
    [ind.id, ind.version, { state: null }],
    [st.id, st.version, { value: null }],
    [ind.id, ind.version, { correction: null }],
    [ind.id, ind.version, { autoValue: null, autoState: null }],
    [op.id, 1, { item: null, acquisitionMethod: null }],
  ] as const) {
    const res = await patch(id, version, fields);
    assert.equal(res.statusCode, 200, `${JSON.stringify(fields)}: ${res.body}`);
    assert.equal(res.json().version, version, `${JSON.stringify(fields)}: не правка`);
  }
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${ind.id}`)).json().fields.value, "ALPHA");
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${st.id}`)).json().fields.state, "not_established");
});

test("T280, T269: значение из одного U+FEFF — с меткой нарушения формата", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const node = await createTestObject(svc, u1, "infra_node", { case: c.id });
  const res = await postIndicator(svc, u1, node.id, "ip", { value: "﻿" });
  assert.equal(res.statusCode, 201, res.body);
  assert.ok((res.json().view.marks as string[]).includes("format_violation"), JSON.stringify(res.json().view.marks));
});

test("T287, T276: null у поля, которого нет, при создании — как при правке: не отказ", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const ind = await postIndicator(svc, u1, op.id, "callsign", { value: "A", state: null, correction: null, reason: null });
  assert.equal(ind.statusCode, 201, ind.body);
  assert.equal(ind.json().fields.state, undefined);
  const node = await callAs(svc, u1, "POST", "/api/records", { type: "object", fields: { kind: T.object("key"), case: c.id, item: null, acquisitionMethod: null } });
  assert.equal(node.statusCode, 201, node.body);
});

test("T288, T289: null у поля при правке — снятие поля; «$» отказывается и с null при создании", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1, { seizedAt: "2026-10-01" });
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const withValue = (await postIndicator(svc, u1, op.id, "callsign", { value: "ALPHA", note: "n" })).json();
  const toState = await callAs(svc, u1, "PATCH", `/api/records/${withValue.id}`, { expectedVersion: 1, fields: { value: null, state: "absent" } });
  assert.equal(toState.statusCode, 200, toState.body);
  assert.deepEqual([toState.json().fields.value, toState.json().fields.state], [undefined, "absent"]);
  const noNote = await callAs(svc, u1, "PATCH", `/api/records/${withValue.id}`, { expectedVersion: 2, fields: { note: null } });
  assert.equal(noNote.statusCode, 200, noNote.body);
  assert.equal(noNote.json().fields.note, undefined);
  const withState = (await postIndicator(svc, u1, op.id, "username", { state: "not_established", reason: "r" })).json();
  const toValue = await callAs(svc, u1, "PATCH", `/api/records/${withState.id}`, { expectedVersion: 1, fields: { value: "bravo", state: null, reason: null } });
  assert.equal(toValue.statusCode, 200, toValue.body);
  assert.deepEqual([toValue.json().fields.value, toValue.json().fields.state], ["bravo", undefined]);
  const seized = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: c.version, fields: { seizedAt: null } });
  assert.notEqual(seized.statusCode, 500, seized.body);
  const reserved = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: EV("case_shape", "single_item"), $secret: null } });
  assert.deepEqual([reserved.statusCode, reserved.json().error], [400, "invalid_request"], reserved.body);
});

test("T293, DATA-19: исполнители по умолчанию правятся обычной правкой (решение T293)", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  const c = await createTestCase(svc, u1);
  assert.deepEqual(c.fields.performers, [u1]);
  const res = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: c.version, fields: { performers: [u2] } });
  assert.equal(res.statusCode, 200, res.body);
});

test("T294, DATA-28: указатели источника — непустые печатные строки", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  for (const source of [
    { kind: "agent", client: "", model: "m", version: "1", assignment: "a" },
    { kind: "agent", client: "c", model: " ", version: "1", assignment: "a" },
    { kind: "auto", parser: "", file: "f" },
    { kind: "auto", program: "\t" },
    { kind: "import", unit: " " },
  ]) {
    const res = await postIndicator(svc, u1, op.id, "callsign", { value: "x", source });
    assert.deepEqual([res.statusCode, res.json().error], [400, "model_invalid"], `${JSON.stringify(source)}: ${res.body}`);
  }
});

test("T299, DATA-10: связь Изделия с частью чужого Изделия — model_invalid", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const ca = await createTestCase(svc, u1);
  const cb = await createTestCase(svc, u1);
  const i1 = await createTestItem(svc, u1, ca.id, "flight_controller");
  const i3 = await createTestItem(svc, u1, cb.id, "flight_controller");
  const profile = await createTestObject(svc, u1, "flight_profile", { item: i1.id });
  const link = (from: string) => callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("has_profile"), from, to: profile.id, confidence: "high", source: { kind: "manual" } } });
  assert.equal((await link(i1.id)).statusCode, 201);
  const foreign = await link(i3.id);
  assert.deepEqual([foreign.statusCode, foreign.json().error], [400, "model_invalid"], foreign.body);
});
