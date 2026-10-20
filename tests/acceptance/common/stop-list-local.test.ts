// T063 — список «Местное» (DICT-40, DICT-43, DICT-45): строка без пояснения — отказ; с пояснением —
// значения Банка сразу помечены и не опознают; удаление строки — предложением, принятое снимает пометку (T099).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, createTestCase, createTestItem, createTestObject, postIndicator, proposeLocal } from "../../support/dictionary.ts";

test("строка «Местного»: пояснение обязательно; пометка сразу; удаление снимает", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const x = (await postIndicator(svc, u1, op.id, "username", { value: "x" })).json();
  assert.equal(x.view.identifying, true);
  const noNote = await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("username"), kind: "value", value: "x", note: "" }, false);
  assert.equal(noNote.statusCode, 400);
  const added = await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("username"), kind: "value", value: "x", note: "типовая учётка" });
  assert.equal(added.statusCode, 200, added.body);
  const marked = (await callAs(svc, u1, "GET", `/api/records/${x.id}`)).json();
  assert.equal(marked.view.stopList.listLabel, "Местное");
  assert.equal(marked.view.identifying, false);
  const entryId = added.json().resultId as string;
  // T099: удаление строки — тоже предложение: пока Старший не принял, пометка стоит; прямого маршрута нет.
  assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/local-extension/stop-list/${encodeURIComponent(entryId)}/remove`, {})).statusCode, 404);
  const removal = await proposeLocal(svc, u1, "stop_list_entry", { remove: entryId }, false);
  assert.equal(removal.statusCode, 201, removal.body);
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${x.id}`)).json().view.stopList.listLabel, "Местное", "предложено — не действует");
  const rejected = await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${removal.json().id}/reject`, { reason: "строка нужна" });
  assert.equal(rejected.json().state, "rejected");
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { remove: entryId })).statusCode, 200);
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${x.id}`)).json().view.stopList, null);
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { remove: entryId }, false)).statusCode, 400, "строки уже нет");
  const actions = svc.db.prepare("SELECT action FROM journal WHERE action LIKE 'stop-list.local.%' ORDER BY seq").all().map((r) => r["action"]);
  assert.deepEqual(actions, ["stop-list.local.add", "stop-list.local.remove"]);
  // В предложении строки нет Кейсов, где значение встретилось (DICT-45).
  assert.deepEqual(Object.keys(added.json().payload).sort(), ["kind", "note", "type", "value"]);
});

test("T083, DICT-41: строка «Местного» сравнивается после нормализации по нынешнему Классу типа", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("username"), kind: "value", value: "X", note: "п" })).statusCode, 200);
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => (b.elements.find((e) => e.id === T.indicator("username"))!.props["normClass"] = "строка")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const ind = (await postIndicator(svc, u1, op.id, "username", { value: "X" })).json();
  assert.equal(ind.view.stopList?.listLabel, "Местное");
  assert.equal(ind.view.identifying, false);
});

test("T176, DICT-41: строка «Местного» вида range с неразбираемым CIDR — 400, а не 500 при принятии", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  for (const value of ["10.0.0.0", "10.0.0.0/99", "abc/8"]) {
    const res = await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("ip"), kind: "range", value, note: "n" }, false);
    assert.equal(res.statusCode, 400, `${value}: ${res.body}`);
  }
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("ip"), kind: "range", value: "192.0.2.0/24", note: "n" })).statusCode, 200);
});

test("T182, DICT-17: строка range «Местного» при типе, переставшем быть ip, не роняет применение — она не действует", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("ip"), kind: "range", value: "192.0.2.0/24", note: "n" })).statusCode, 200);
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      b.elements.find((e) => e.id === T.indicator("ip"))!.props["normClass"] = "строка";
      b.stopLists[0]!.rows = b.stopLists[0]!.rows.filter((r) => r[1] !== "range");
    }),
  );
  const res = await callMaintenance(svc, "POST", "/api/dictionary/versions", v2);
  assert.equal(res.statusCode, 201, res.body);
  const view = (await callAs(svc, u1, "GET", "/api/local-extension")).json() as { stopList: { kind: string; dormant: boolean }[] };
  assert.deepEqual(view.stopList.map((r) => [r.kind, r.dormant]), [["range", true]]);
});

test("T187, DICT-37: одинокий суррогат в тексте предложения — 400, а не искажённое хранение", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const res = await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("username"), kind: "value", value: "a\ud800b", note: "n" }, false);
  assert.equal(res.statusCode, 400, res.body);
});

test("T216, DICT-41: строка Стоп-листа Сети поглощённого типа показывается по канону", async (t) => {
  const { callMaintenance } = await import("../../support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.indicator("os_note"))!;
      el.state = "absorbed";
      el.canonical = T.indicator("hostname");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
      b.stopLists[0]!.rows.push([T.indicator("os_note"), "value", "Host.Example.COM", "имя по умолчанию"]);
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const items = (await callAs(svc, u1, "GET", "/api/dictionary/stop-lists/common_defaults/entries")).json().items as { typeId: string; value: string; normalized: string }[];
  const row = items.find((r) => r.value === "Host.Example.COM")!;
  assert.equal(row.typeId, T.indicator("hostname"));
  assert.equal(row.normalized, "host", "по Классу канона «имя-хоста», а не «строка»");
});

test("T228, DICT-41: строка «Местного» проверяется, как строка Сети: нормализуется Классом типа, без повторов", async (t) => {
  const { proposeLocal } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const row = (type: string, value: string) => proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator(type), kind: "value", value, note: "проверка" }, false);
  assert.equal((await row("ip", "999.1.1.1")).statusCode, 400, "не адрес");
  assert.equal((await row("file_sha256", "zz-not-hex")).statusCode, 400, "не hex");
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("domain"), kind: "value", value: "Example.COM", note: "проверка" })).statusCode, 200);
  assert.equal((await row("domain", "example.com")).statusCode, 400, "повтор после нормализации");
});

test("T239, DICT-44: фильтр по списку «Местное» находит значение, совпавшее и со строкой Сети", async (t) => {
  const { proposeLocal } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const ind = (await postIndicator(svc, u1, op.id, "username", { value: "v" })).json();
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("username"), kind: "value", value: "v", note: "и у нас" })).statusCode, 200);
  const ids = async (list: string) => ((await callAs(svc, u1, "GET", `/api/indicators?stopList=${encodeURIComponent(list)}`)).json().items as { id: string }[]).map((i) => i.id);
  assert.deepEqual(await ids("common_defaults"), [ind.id]);
  assert.deepEqual(await ids("A:local"), [ind.id]);
});

test("T245, DICT-41: шаблон «Местного» — в нормализованной форме Класса, иначе отказ", async (t) => {
  const { proposeLocal } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const pattern = (type: string, value: string, decide = true) => proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator(type), kind: "pattern", value, note: "шаблон" }, decide);
  assert.equal((await pattern("hostname", "MyBoard*", false)).statusCode, 400, "имя хоста — в нижнем регистре");
  assert.equal((await pattern("hostname", "myboard*")).statusCode, 200);
  assert.equal((await pattern("domain", "*.Пример.РФ")).statusCode, 200, "домен приводится к A-меткам");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  assert.equal((await postIndicator(svc, u1, platform.id, "hostname", { value: "MyBoard5" })).json().view.stopList?.listLabel, "Местное");
  const node = await createTestObject(svc, u1, "infra_node", { case: c.id });
  assert.equal((await postIndicator(svc, u1, node.id, "domain", { value: "c2.пример.рф" })).json().view.stopList?.listLabel, "Местное");
});

test("T258, DICT-41: префиксные шаблоны в нормальной форме принимаются и помечают значения", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const pattern = (type: string, value: string) => proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator(type), kind: "pattern", value, note: "шаблон" });
  for (const [type, value] of [["ip", "192.168.*"], ["ip", "fe80::*"], ["win_volume_guid", "00000000-*"]] as const) assert.equal((await pattern(type, value)).statusCode, 200, `${type} ${value}`);
  const c = await createTestCase(svc, u1);
  const node = await createTestObject(svc, u1, "infra_node", { case: c.id });
  assert.equal((await postIndicator(svc, u1, node.id, "ip", { value: "192.168.1.1" })).json().view.stopList?.listLabel, "Местное");
});

test("T270, T272: шаблоны ssh-ключ и целое — в алфавите нормальной формы; строка на весь тип — ослабление", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const row = (type: string, kind: string, value: string) => proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator(type), kind, value, note: "проверка" }, false);
  assert.equal((await row("ssh_fingerprint", "pattern", "SHA256:AAAA*")).statusCode, 400, "префикс SHA256: в нормальной форме снят");
  assert.equal((await row("wfb_link_id", "pattern", "-*")).statusCode, 400, "целое без минуса");
  for (const [type, kind, value] of [["domain", "pattern", "*"], ["hostname", "pattern", "?*"], ["ip", "range", "0.0.0.0/0"], ["ip", "range", "::/0"]] as const) {
    const res = await row(type, kind, value);
    assert.deepEqual([res.statusCode, res.json().error], [422, "local_weakening"], `${type} ${value}: ${res.body}`);
  }
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("ssh_fingerprint"), kind: "pattern", value: "AAAA*", note: "проверка" })).statusCode, 200);
});

test("T277, T278, T279: весь тип — по нормальной форме; значение — по формату типа; только свои типы", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const row = (type: string, kind: string, value: string) => proposeLocal(svc, u1, "stop_list_entry", { type, kind, value, note: "проверка" }, false);
  for (const [type, value] of [["domain", "*."], ["username", "*­"]] as const) {
    const res = await row(T.indicator(type), "pattern", value);
    assert.deepEqual([res.statusCode, res.json().error], [422, "local_weakening"], `${type} ${JSON.stringify(value)}: ${res.body}`);
  }
  for (const [type, value] of [["domain", "localhost"], ["file_sha256", "ab"]] as const) assert.equal((await row(T.indicator(type), "value", value)).statusCode, 400, `${type} ${value}`);
  const foreign = "0190a000-0000-7000-8000-00000000b001";
  svc.db
    .prepare("INSERT INTO dict_element (id, code, label, kind, level, state, canonicalId, sinceVersion, props) VALUES (?, 'B:x', 'x', 'indicator_type', 'local', 'active', NULL, NULL, ?)")
    .run(foreign, JSON.stringify({ object: T.object("operator"), format: "строка:64", comparable: false, normClass: "строка", identifying: "none", autoSecret: false }));
  const { invalidateDictionary } = await import("@aristotel/core");
  invalidateDictionary(svc.db);
  assert.equal((await row(foreign, "value", "zz")).statusCode, 400, "строка по чужому местному типу");
  assert.equal((await proposeLocal(svc, u1, "template_field", { class: "companion", block: "os", label: "Чужое", indicatorType: foreign }, false)).statusCode, 422, "поле чужого местного типа");
});

test("T283, DICT-44: строка и фильтр Стоп-листа — по правилу пробелов значения Индикатора", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const add = (value: string) => proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("hw_model"), kind: "value", value, note: "модель по умолчанию" });
  assert.equal((await add("RPI4")).statusCode, 200);
  assert.equal((await add("Pi\u0085")).statusCode, 200);
  const c = await createTestCase(svc, u1);
  const hw = await createTestObject(svc, u1, "hw_element", { case: c.id });
  const nel = (await postIndicator(svc, u1, hw.id, "hw_model", { value: "RPI4\u0085" })).json();
  const ids = ((await callAs(svc, u1, "GET", "/api/indicators?stopList=A:local")).json().items as { id: string }[]).map((i) => i.id);
  assert.ok(ids.includes(nel.id), "значение с NEL находится фильтром, раз помечено");
  assert.equal((await postIndicator(svc, u1, hw.id, "hw_model", { value: "Pi" })).json().view.stopList?.listLabel, "Местное", "строка «Pi\\u0085» помечает «Pi»");
});

test("T290, T291: шаблон из подстановок и разделителей — на весь тип; «Местное» есть с применения Словаря", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  assert.equal((await callAs(svc, u1, "GET", "/api/indicators?stopList=A:local")).statusCode, 200, "список есть до первой строки");
  assert.ok(((await callAs(svc, u1, "GET", "/api/dictionary/stop-lists")).json().items as { code: string }[]).some((l) => l.code === "A:local"));
  for (const [type, value] of [["domain", "*.*"], ["win_volume_guid", "*-*-*-*-*"], ["ip", "*.*.*.*"], ["ip", "*:*"]] as const) {
    const res = await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator(type), kind: "pattern", value, note: "x" }, false);
    assert.deepEqual([res.statusCode, res.json().error], [422, "local_weakening"], `${type} ${value}: ${res.body}`);
  }
  assert.equal((await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("domain"), kind: "pattern", value: "*.example.test", note: "x" })).statusCode, 200);
});
