// T061 — Местное расширение (SC-006; DICT-03, DICT-05 … DICT-08, DICT-11, DICT-25, DICT-56, DICT-57,
// DICT-61; Clarifications фичи 005): предложения и решения Старшего; ужесточение проходит, ослабление —
// 422 local_weakening; местный тип не сопоставляется и не опознаёт; всё — в журнале.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, createTestCase, createTestItem, createTestObject, nextTestVersion, postIndicator, proposeLocal, signWithTestCoordinator } from "../../support/dictionary.ts";

async function stand(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  return { svc, u1: svc.addMember("У1") };
}

test("местный тип: предложено — не действует; принят — Код A:<код>, UUIDv7, не сопоставляется и не опознаёт", async (t) => {
  const { svc, u1 } = await stand(t);
  const p = await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "type", payload: { code: "x_quirk", label: "x", object: T.object("operator"), format: "строка:64", normClass: "строка" } });
  assert.equal(p.statusCode, 201, p.body);
  assert.equal(p.json().state, "proposed");
  assert.equal((await callAs(svc, u1, "GET", "/api/dictionary/elements?code=A:x_quirk")).json().items.length, 0, "до решения не действует");
  assert.equal((await callAs(svc, u1, "POST", `/api/local-extension/proposals/${p.json().id}/accept`, {})).statusCode, 403, "Участник не решает");
  const accepted = await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.json().id}/accept`, {});
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().state, "accepted");
  const [el] = (await callAs(svc, u1, "GET", "/api/dictionary/elements?code=A:x_quirk")).json().items;
  assert.match(el.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.deepEqual([el.level, el.props.comparable, el.props.identifying], ["local", false, "none"]);
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const ind = (await callAs(svc, u1, "POST", "/api/records", { type: "indicator", fields: { object: op.id, type: el.id, value: "x", source: { kind: "manual" }, case: c.id } })).json();
  assert.equal(ind.view.identifying, false, "местный тип не опознаёт (DICT-57)");
  assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.json().id}/accept`, {})).json().error, "proposal_not_open");
});

test("отклонение — только с причиной; решение и автор — в журнале", async (t) => {
  const { svc, u1 } = await stand(t);
  const p = (await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "type", payload: { code: "y_type", label: "y", object: T.object("operator"), format: "строка:64" } })).json();
  assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.id}/reject`, {})).statusCode, 400);
  const r = await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.id}/reject`, { reason: "x" });
  assert.equal(r.json().state, "rejected");
  const actions = svc.db.prepare("SELECT action, actorId FROM journal WHERE subjectType = 'local-extension' ORDER BY seq").all().map((x) => [x["action"], x["actorId"]]);
  assert.deepEqual(actions, [["local-extension.propose", u1], ["local-extension.reject", svc.seniorId]]);
});

test("ужесточение: строгий → нестрогий и автоматический Секрет — проходят; после второго новые Индикаторы — Секрет", async (t) => {
  const { svc, u1 } = await stand(t);
  assert.equal((await proposeLocal(svc, u1, "override", { element: T.indicator("ip"), property: "identifying", value: "loose" })).statusCode, 200);
  assert.equal((await callAs(svc, u1, "GET", "/api/dictionary/elements?code=ip")).json().items[0].props.identifying, "loose");
  assert.equal((await proposeLocal(svc, u1, "override", { element: T.indicator("hostname"), property: "autoSecret", value: true })).statusCode, 200);
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  assert.equal((await postIndicator(svc, u1, platform.id, "hostname", { value: "x" })).json().secret, true);
});

test("ослабление правил Сети — 422 local_weakening (SC-006: все шесть)", async (t) => {
  const { svc, u1 } = await stand(t);
  const attempts: Record<string, unknown>[] = [
    { element: T.indicator("recovered_password"), property: "autoSecret", value: false },
    { element: T.indicator("os_note"), property: "comparable", value: true },
    { element: T.indicator("username"), property: "identifying", value: "strict" },
    { element: T.indicator("hostname"), property: "normClass", value: "строка" },
    { element: T.indicator("ip"), property: "identifying", value: "none" },
    { element: T.indicator("username"), property: "crossCompare", value: [] },
    // T302: и прочие свойства типа — по-русски.
    { element: T.indicator("hostname"), property: "format", value: "x" },
    { element: T.indicator("hostname"), property: "object", value: T.object("operator") },
    { element: T.indicator("hostname"), property: "legacyNames", value: ["x"] },
  ];
  for (const payload of attempts) {
    const res = await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "override", payload });
    assert.deepEqual([res.statusCode, res.json().error], [422, "local_weakening"], JSON.stringify(payload));
    // T298: правило — по-русски, без ключа.
    assert.doesNotMatch(res.json().message, /comparable|normClass|crossCompare|autoSecret|identifying|\bformat\b|\bobject\b|legacyNames/, res.json().message);
  }
  const closed = await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "enum_value", payload: { enum: "item_class", code: "x", label: "x" } });
  assert.deepEqual([closed.statusCode, closed.json().error], [422, "local_weakening"], "закрытый перечень (DICT-60)");
});

test("значение открытого перечня и поле шаблона местного типа — предложением; поле необязательное", async (t) => {
  const { svc, u1 } = await stand(t);
  assert.equal((await proposeLocal(svc, u1, "enum_value", { enum: "os_distro", code: "x_os", label: "x" })).statusCode, 200);
  const type = await proposeLocal(svc, u1, "type", { code: "z_note", label: "z", object: T.object("platform"), format: "строка:64" });
  const typeId = type.json().resultId as string;
  assert.equal((await proposeLocal(svc, u1, "template_field", { class: "companion", block: "os", label: "Заметка z", indicatorType: typeId })).statusCode, 200);
  const os = (await callAs(svc, u1, "GET", "/api/form?class=companion")).json().blocks.find((b: { block: string }) => b.block === "os");
  const field = os.fields.find((f: { label: string }) => f.label === "Заметка z");
  assert.deepEqual([field.local, field.required], [true, false]);
  const netType = await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "template_field", payload: { class: "companion", block: "os", label: "x", indicatorType: T.indicator("hostname") } });
  assert.equal(netType.json().error, "local_weakening", "поле шаблона — только местного типа");
});

test("чужой местный тип (B:<код>) не сопоставляется, не опознаёт и в Местное расширение A не попадает (DICT-25)", async (t) => {
  const { svc } = await stand(t);
  svc.db.prepare("INSERT INTO dict_element (id, code, label, kind, level, state, canonicalId, sinceVersion, props) VALUES ('b-1', 'B:x', 'x', 'indicator_type', 'local', 'active', NULL, NULL, ?)").run(
    JSON.stringify({ object: T.object("operator"), format: "строка:64", comparable: true, normClass: "строка", identifying: "strict", autoSecret: false }),
  );
  const { invalidateDictionary } = await import("@aristotel/core");
  invalidateDictionary(svc.db);
  const view = (await callAs(svc, svc.seniorId, "GET", "/api/dictionary/elements?code=B:x")).json().items[0];
  assert.deepEqual([view.props.comparable, view.props.identifying], [false, "none"]);
  const own = (await callAs(svc, svc.seniorId, "GET", "/api/local-extension")).json();
  assert.ok(!own.types.some((x: { code: string }) => x.code === "B:x"));
});

test("T086, ROLE-25: автоматическая метка Секрет — общей операцией: updatedBy, история и журнал с Кейсом", async (t) => {
  const { svc, u1 } = await stand(t);
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const ind = (await postIndicator(svc, u1, platform.id, "hostname", { value: "x" })).json();
  assert.equal((await proposeLocal(svc, u1, "override", { element: T.indicator("hostname"), property: "autoSecret", value: true })).statusCode, 200);
  const row = svc.db.prepare("SELECT secret, version, updatedBy FROM record WHERE id = ?").get(ind.id);
  assert.deepEqual([row?.["secret"], row?.["version"], row?.["updatedBy"]], [1, 2, svc.seniorId]);
  const h = svc.db.prepare("SELECT authorId FROM record_history WHERE recordId = ? AND field = '$secret'").get(ind.id);
  assert.equal(h?.["authorId"], svc.seniorId);
  const j = svc.db.prepare("SELECT actorId, caseId FROM journal WHERE action = 'record.secret.mark' AND subjectId = ?").get(ind.id);
  assert.deepEqual([j?.["actorId"], j?.["caseId"]], [svc.seniorId, c.id]);
});

test("T105, DICT-60: местный тип с закрытым перечнем — 422 local_weakening; значение вне закрытого перечня — отказ", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const local = await proposeLocal(svc, u1, "type", { code: "x_kind", label: "x", object: T.object("operator"), format: "перечень:material_kind" }, false);
  assert.deepEqual([local.statusCode, local.json().error], [422, "local_weakening"]);
  // Тип Сети с перечнем поля программы версия не приносит: эти перечни «обслуживают поля программы, а
  // не Индикаторы» (приложение §7; T304) — отказ content.
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) =>
      b.elements.push({ id: "0190a000-0000-7000-8000-0000000a0105", code: "x_shape", label: "x", kind: "indicator_type", state: "active", sinceVersion: 2, props: { object: T.object("operator"), format: "перечень:case_shape", comparable: false, normClass: null, identifying: "none", autoSecret: false } }),
    ),
  );
  const res = await callMaintenance(svc, "POST", "/api/dictionary/versions", v2);
  assert.deepEqual([res.statusCode, res.json().reason], [422, "content"], res.body);
});

test("T177, DICT-45: пояснение и причина из одних управляющих символов — 400, а не 500", async (t) => {
  const { svc, u1 } = await stand(t);
  const row = await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("username"), kind: "value", value: "x", note: "\u0000" }, false);
  assert.equal(row.statusCode, 400, row.body);
  const p = (await proposeLocal(svc, u1, "enum_value", { enum: T.enumOf("os_distro"), code: "x_distro", label: "x" }, false)).json();
  const reject = await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.id}/reject`, { reason: "\u0000\u0001" });
  assert.equal(reject.statusCode, 400, reject.body);
});

test("T193, DICT-08: поле шаблона для местного типа, склеенного в тип Сети, — local_weakening", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const localId = (await proposeLocal(svc, u1, "type", { code: "lt", label: "x", object: T.object("platform"), format: "строка:64" })).json().resultId as string;
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => b.merges.push({ local: "A:lt", localId, canonical: T.indicator("os_note") })));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const res = await proposeLocal(svc, u1, "template_field", { class: "companion", block: "os", label: "y", indicatorType: localId }, false);
  assert.deepEqual([res.statusCode, res.json().error], [422, "local_weakening"], res.body);
});

test("T194, DICT-10: местный тип с перечнем, которого нет в Словаре, — 400", async (t) => {
  const { svc, u1 } = await stand(t);
  const res = await proposeLocal(svc, u1, "type", { code: "x_nope", label: "x", object: T.object("operator"), format: "перечень:nope" }, false);
  assert.equal(res.statusCode, 400, res.body);
});

test("T197, DICT-10: формат местного типа «перечень:<Код>» переживает переименование перечня версией", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const local = await proposeLocal(svc, u1, "type", { code: "x_distro", label: "x", object: T.object("operator"), format: "перечень:os_distro" });
  assert.equal(local.statusCode, 200, local.body);
  const localId = local.json().resultId as string;
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      b.elements.find((e) => e.id === T.enumOf("os_distro"))!.code = "os_family";
      b.elements.find((e) => e.id === T.indicator("os_distro"))!.props["format"] = "перечень:os_family";
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const [el] = (await callAs(svc, u1, "GET", "/api/dictionary/elements?code=A:x_distro")).json().items;
  assert.equal(el.props.format, "перечень:os_family");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const ind = await callAs(svc, u1, "POST", "/api/records", { type: "indicator", fields: { object: op.id, type: localId, value: "debian", source: { kind: "manual" }, case: c.id } });
  assert.equal(ind.statusCode, 201, ind.body);
  assert.deepEqual(ind.json().view.marks, [], "значение перечня — не «вне Словаря»");
});

test("T205, ROLE-25: снятая Старшим метка Секрет не возвращается следующей версией и чужим ужесточением", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const ind = (await postIndicator(svc, u1, platform.id, "recovered_password", { value: "p" })).json();
  assert.equal(ind.secret, true);
  const unmarked = await callAs(svc, svc.seniorId, "POST", `/api/records/${ind.id}/secret/unmark`, { expectedVersion: ind.version });
  assert.equal(unmarked.statusCode, 200, unmarked.body);
  const secret = async () => (await callAs(svc, svc.seniorId, "GET", `/api/records/${ind.id}`)).json().secret;
  const v2 = signWithTestCoordinator(nextTestVersion(v1, (b) => (b.elements.find((e) => e.id === T.object("operator"))!.label = "Оператор БпЛА")));
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  assert.equal(await secret(), false, "версия без смены autoSecret метку не возвращает");
  assert.equal((await proposeLocal(svc, u1, "override", { element: T.indicator("hostname"), property: "autoSecret", value: true })).statusCode, 200);
  assert.equal(await secret(), false, "ужесточение другого типа метку не возвращает");
});

test("T204, DICT-60: перечень поля программы местно не дополняется и при флаге closed: false в данных", async (t) => {
  const { invalidateDictionary } = await import("@aristotel/core");
  const { svc, u1 } = await stand(t);
  svc.db.prepare("UPDATE dict_element SET props = json_set(props, '$.closed', json('false')) WHERE id = ?").run(T.enumOf("item_class"));
  invalidateDictionary(svc.db);
  const res = await proposeLocal(svc, u1, "enum_value", { enum: "item_class", code: "x_local", label: "x" }, false);
  assert.deepEqual([res.statusCode, res.json().error], [422, "local_weakening"], res.body);
});

test("T209, DICT-63: местное значение перечня по внешнему стандарту — Код-идентификатор стандарта", async (t) => {
  const { svc, u1 } = await stand(t);
  for (const [en, code] of [["country", "XK"], ["timezone", "America/Ciudad_Juarez"]]) {
    const res = await proposeLocal(svc, u1, "enum_value", { enum: en, code, label: code });
    assert.equal(res.statusCode, 200, `${en}.${code}: ${res.body}`);
  }
  assert.equal((await proposeLocal(svc, u1, "enum_value", { enum: "os_distro", code: "Arch", label: "x" }, false)).statusCode, 400, "прочие перечни — snake_case");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  assert.deepEqual((await postIndicator(svc, u1, platform.id, "country", { value: "XK" })).json().view.marks, []);
});

test("T211, DICT-64: местное значение перечня и значение Сети с тем же Кодом — местное поглощено значением Сети", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const localId = (await proposeLocal(svc, u1, "enum_value", { enum: "os_distro", code: "arch", label: "Arch местный" })).json().resultId as string;
  const networkId = "0190a000-0000-7000-8000-0000000a0c11";
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => b.elements.push({ id: networkId, code: "arch", label: "Arch Linux", kind: "enum_value", state: "active", sinceVersion: 2, props: { enum: T.enumOf("os_distro") } })),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const local = svc.db.prepare("SELECT state, canonicalId FROM dict_element WHERE id = ?").get(localId);
  assert.deepEqual([local?.["state"], local?.["canonicalId"]], ["absorbed", networkId]);
  const details = JSON.parse(String(svc.db.prepare("SELECT details FROM journal WHERE action = 'dictionary.apply' AND subjectId = '2'").get()?.["details"]));
  assert.equal(details.localValuesMerged, 1);
  assert.ok((details.mergedTypes as { absorbed: string; canonical: string }[]).some((m) => m.absorbed === localId && m.canonical === networkId));
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const ind = (await postIndicator(svc, u1, platform.id, "os_distro", { value: "arch" })).json();
  assert.deepEqual(ind.view.marks, []);
  assert.match(ind.view.label, /^Дистрибутив: arch/);
});

test("T221, DATA-26: подпись и значение в предложениях — хотя бы один печатный символ", async (t) => {
  const { svc, u1 } = await stand(t);
  const typeId = (await proposeLocal(svc, u1, "type", { code: "ok_type", label: "x", object: T.object("platform"), format: "строка:64" })).json().resultId as string;
  const attempts: [string, Record<string, unknown>][] = [
    ["type", { code: "blank_type", label: "   ", object: T.object("operator"), format: "строка:64" }],
    ["enum_value", { enum: "os_distro", code: "blank", label: " \t" }],
    ["template_field", { class: "companion", block: "os", label: "  ", indicatorType: typeId }],
    ["stop_list_entry", { type: T.indicator("username"), kind: "value", value: "   ", note: "пусто" }],
  ];
  for (const [kind, payload] of attempts) assert.equal((await proposeLocal(svc, u1, kind, payload, false)).statusCode, 400, kind);
});

test("T225, DICT-14: принятое местное значение перечня снимает «вне Словаря» с уже заведённых Индикаторов", async (t) => {
  const { svc, u1 } = await stand(t);
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const platform = await createTestObject(svc, u1, "platform", { item: item.id });
  const ind = (await postIndicator(svc, u1, platform.id, "os_distro", { value: "x_os" })).json();
  assert.deepEqual(ind.view.marks, ["out_of_dictionary"]);
  assert.equal((await proposeLocal(svc, u1, "enum_value", { enum: "os_distro", code: "x_os", label: "x" })).statusCode, 200);
  assert.deepEqual((await callAs(svc, u1, "GET", `/api/records/${ind.id}`)).json().view.marks, []);
});

test("T229, DICT-23: Местное расширение показывает состояние и канон поглощённого значения", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const localId = (await proposeLocal(svc, u1, "enum_value", { enum: "os_distro", code: "arch", label: "Arch местный" })).json().resultId as string;
  const networkId = "0190a000-0000-7000-8000-0000000a0c12";
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => b.elements.push({ id: networkId, code: "arch", label: "Arch Linux", kind: "enum_value", state: "active", sinceVersion: 2, props: { enum: T.enumOf("os_distro") } })),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const view = (await callAs(svc, u1, "GET", "/api/local-extension")).json();
  const value = (view.enumValues as { id: string; state: string; canonicalId: string | null; enumCode: string }[]).find((v) => v.id === localId)!;
  assert.deepEqual([value.state, value.canonicalId, value.enumCode], ["absorbed", networkId, "os_distro"]);
});

test("T230, DICT-07: ужесточение, которое уже действует, принимается без изменений", async (t) => {
  const { svc, u1 } = await stand(t);
  const loose = { element: T.indicator("ip"), property: "identifying", value: "loose" };
  const first = (await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "override", payload: loose })).json();
  const second = (await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "override", payload: loose })).json();
  assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${first.id}/accept`, {})).statusCode, 200);
  assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${second.id}/accept`, {})).statusCode, 200, "повтор — без изменений");
  assert.equal((await proposeLocal(svc, u1, "override", { element: T.indicator("username"), property: "identifying", value: "loose" })).statusCode, 200, "у Сети уже нестрогий");
  const weak = await proposeLocal(svc, u1, "override", { element: T.indicator("hostname"), property: "identifying", value: "strict" }, false);
  assert.equal(weak.statusCode, 422);
  const text = weak.json().message as string;
  assert.match(text, /строгость опознания/);
  assert.doesNotMatch(text, /\bidentifying\b/);
  assert.equal(text.match(/DICT-07/g)?.length, 1, "коды требований — один раз");
});

test("T238: отказ предложения называет поле по-русски", async (t) => {
  const { svc, u1 } = await stand(t);
  const res = await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "type", payload: { code: "x_t", object: T.object("operator"), format: "строка:64" } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /Подпись/);
  assert.doesNotMatch(res.json().message, /: type\.?$/);
  const unknown = await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "enum_value", payload: { enum: "nope", code: "x", label: "x" } });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().message, /перечень/);
});

test("T244, DICT-07: ужесточение поглощённого типа — отказ, ужесточается канон", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.indicator("callsign"))!;
      el.state = "absorbed";
      el.canonical = T.indicator("username");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  const res = await proposeLocal(svc, u1, "override", { element: T.indicator("callsign"), property: "autoSecret", value: true }, false);
  assert.equal(res.statusCode, 422, res.body);
  assert.match(res.json().message, /username/);
  assert.equal((await proposeLocal(svc, u1, "override", { element: T.indicator("username"), property: "autoSecret", value: true })).statusCode, 200);
});

test("T250, DICT-65: принятое местное значение geo_precision снимает «вне Словаря» с Индикаторов формата «гео»", async (t) => {
  const { svc, u1 } = await stand(t);
  const c = await createTestCase(svc, u1);
  const geo = await createTestObject(svc, u1, "geo_object", { case: c.id });
  const ind = (await postIndicator(svc, u1, geo.id, "geo_shape", { value: "1.5,2.5 km_50", case: c.id })).json();
  assert.deepEqual(ind.view.marks, ["out_of_dictionary"]);
  assert.equal((await proposeLocal(svc, u1, "enum_value", { enum: "geo_precision", code: "km_50", label: "до 50 км" })).statusCode, 200);
  assert.deepEqual((await callAs(svc, u1, "GET", `/api/records/${ind.id}`)).json().view.marks, []);
});

test("T264, DICT-63: местное значение country — ISO 3166-1 alpha-2", async (t) => {
  const { svc, u1 } = await stand(t);
  for (const code of ["Not.A-Country", "XYZ", "zz"]) assert.equal((await proposeLocal(svc, u1, "enum_value", { enum: "country", code, label: code }, false)).statusCode, 400, code);
  assert.equal((await proposeLocal(svc, u1, "enum_value", { enum: "country", code: "XK", label: "Kosovo" })).statusCode, 200);
});

test("T271, T275: местное поле — только в блоке шаблона Сети; местное значение — не прежний Код перечня", async (t) => {
  const { svc, u1 } = await stand(t);
  const typeId = (await proposeLocal(svc, u1, "type", { code: "fc_x", label: "x", object: T.object("flight_profile"), format: "строка:64" })).json().resultId as string;
  const os = await proposeLocal(svc, u1, "template_field", { class: "flight_controller", block: "os", label: "ОС ПК", indicatorType: typeId }, false);
  assert.equal(os.statusCode, 400, "у полётного контроллера нет блока «ОС»");
  assert.equal((await proposeLocal(svc, u1, "template_field", { class: "flight_controller", block: "class", label: "Поле ПК", indicatorType: typeId })).statusCode, 200);
  assert.equal((await proposeLocal(svc, u1, "enum_value", { enum: "timezone", code: "Europe/Kiev", label: "Kiev" }, false)).statusCode, 400, "прежний Код — синоним Europe/Kyiv");
});
