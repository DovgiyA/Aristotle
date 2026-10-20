// T048 — шаг 22.8 в части пометки (фича 005): значение из Стоп-листа помечено — список, пояснение,
// единый текст DICT-43 — и не опознаёт; фильтр по списку (DICT-44). Набор Отпечатков — фича 021.
import { test } from "node:test";
import assert from "node:assert/strict";
import { message } from "@aristotel/protocol";
import { callAs, startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase, createTestObject, postIndicator } from "../../support/dictionary.ts";

test("22.8: значение v из Стоп-листа помечено и не опознаёт; GET /api/indicators?stopList находит его", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const v = (await postIndicator(svc, u1, op.id, "username", { value: "V" })).json();
  assert.deepEqual(v.view.stopList, {
    list: "common_defaults",
    listLabel: "Общие умолчания",
    note: "учётка по умолчанию",
    text: message("stop_list_mark", { list: "Общие умолчания", note: "учётка по умолчанию" }),
  });
  assert.equal(v.view.identifying, false);
  const x = (await postIndicator(svc, u1, op.id, "username", { value: "x" })).json();
  assert.equal(x.view.stopList, null);
  assert.equal(x.view.identifying, true);
  const infra = await createTestObject(svc, u1, "infra_node", { case: c.id });
  const ip = (await postIndicator(svc, u1, infra.id, "ip", { value: "10.1.2.3" })).json();
  assert.equal(ip.view.stopList.list, "common_defaults", "диапазон 10.0.0.0/8");
  const found = (await callAs(svc, u1, "GET", "/api/indicators?stopList=common_defaults")).json().items.map((i: { id: string }) => i.id).sort();
  assert.deepEqual(found, [v.id, ip.id].sort());
});

test("22.8 (T069): v вошло в Стоп-лист версией — пометка появилась; w убрано — пометка снята", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const w = (await postIndicator(svc, u1, op.id, "username", { value: "w" })).json();
  const v = (await postIndicator(svc, u1, op.id, "username", { value: "v" })).json();
  assert.notEqual(v.view.stopList, null);
  assert.equal(w.view.stopList, null);
  const { T, nextTestVersion, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      b.stopLists[0]!.rows = b.stopLists[0]!.rows.filter(([, , value]) => value !== "v");
      b.stopLists[0]!.rows.push([T.indicator("username"), "value", "w", "теперь и w"]);
    }),
  );
  const { callMaintenance } = await import("../../support/harness.ts");
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${w.id}`)).json().view.stopList.note, "теперь и w");
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${v.id}`)).json().view.stopList, null);
  const details = JSON.parse(String(svc.db.prepare("SELECT details FROM journal WHERE action = 'dictionary.apply' AND subjectId = '2'").get()?.["details"]));
  assert.deepEqual([details.stopListGained, details.stopListLost], [1, 1]);
});
