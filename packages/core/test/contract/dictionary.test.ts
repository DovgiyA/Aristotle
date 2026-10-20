// T030 — контракт маршрутов Словаря Сети (contracts/http-api.md фичи 005 «Словарь Сети»): схемы
// ответов, коды ошибок, права, пометка maintenance (конституция III; DICT-16, DICT-17, DICT-42,
// STATION-12, NET-54, APP-34).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../../../tests/support/harness.ts";
import { applyTestDictionary, signWithTestCoordinator, testDictionaryDocument } from "../../../../tests/support/dictionary.ts";

test("GET /api/dictionary: до версии 1 — current: null; после — номер, SHA-256, кто применил, кто подписал", async (t) => {
  const svc = await startTestService(t);
  const h1 = svc.addMember("Н1", "observer");
  assert.deepEqual((await callAs(svc, h1, "GET", "/api/dictionary")).json(), { current: null });
  await applyTestDictionary(svc);
  const body = (await callAs(svc, h1, "GET", "/api/dictionary")).json();
  assert.deepEqual(Object.keys(body.current).sort(), ["appliedAt", "appliedBy", "bodySha256", "number", "signedBy"]);
  assert.deepEqual(Object.keys(body.current.signedBy).sort(), ["key", "keyFingerprint"]);
  assert.equal((await callMaintenance(svc, "GET", "/api/dictionary")).statusCode, 200);
});

test("GET /api/dictionary/versions/:number — документ байт в байт; нет версии — 404", async (t) => {
  const svc = await startTestService(t);
  const doc = await applyTestDictionary(svc);
  const res = await callAs(svc, svc.seniorId, "GET", "/api/dictionary/versions/1");
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).body, doc.body);
  assert.equal((await callAs(svc, svc.seniorId, "GET", "/api/dictionary/versions/2")).statusCode, 404);
  assert.equal((await callMaintenance(svc, "GET", "/api/dictionary/versions/1")).statusCode, 200);
});

test("POST /api/dictionary/versions: 201 — применена, 200 — та же; 422 с reason; тело больше предела — 400 invalid_request", async (t) => {
  const svc = await startTestService(t);
  const doc = await applyTestDictionary(svc);
  const same = await callMaintenance(svc, "POST", "/api/dictionary/versions", doc);
  assert.equal(same.statusCode, 200);
  const bad = await callMaintenance(svc, "POST", "/api/dictionary/versions", { format: "x", body: "{}", signatures: [] });
  assert.deepEqual([bad.statusCode, bad.json().error, bad.json().reason], [422, "dictionary_rejected", "format"]);
  assert.match(bad.json().message, /не по формату aristotel\/slovar\/v1/);
  const huge = await svc.maintenance.inject({
    method: "POST",
    url: "/api/dictionary/versions",
    headers: { ...svc.maintenanceHeaders(), "content-type": "application/json" },
    payload: JSON.stringify({ format: "aristotel/slovar/v1", body: "x".repeat(67 * 1024 * 1024), signatures: [] }),
  });
  // Тело версии больше 64 МиБ проходит транспорт (предел запроса вмещает экранированное тело, T261) и
  // отказывается по формату документа; запрос больше предела маршрута — 400 «больше предела» (T261).
  assert.deepEqual([huge.statusCode, huge.json().error, huge.json().reason], [422, "dictionary_rejected", "format"]);
});

test("права: Наблюдатель читает, Участник не подаёт; elements и stop-lists — только API Станций", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  assert.equal((await callAs(svc, u1, "POST", "/api/dictionary/versions", signWithTestCoordinator(testDictionaryDocument()))).statusCode, 403);
  const elements = await callAs(svc, h1, "GET", "/api/dictionary/elements?kind=indicator_type&code=hostname");
  assert.equal(elements.statusCode, 200);
  const [el] = elements.json().items;
  assert.deepEqual(Object.keys(el).sort(), ["canonicalId", "code", "id", "kind", "label", "level", "props", "sinceVersion", "state"]);
  assert.equal(el.props.normClass, "имя-хоста");
  assert.equal((await callMaintenance(svc, "GET", "/api/dictionary/elements")).json().error, "maintenance_only");
  assert.equal((await callMaintenance(svc, "GET", "/api/dictionary/stop-lists")).json().error, "maintenance_only");
});

test("stop-lists и строки списка страницами по курсору; неизвестный список — 404", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const lists = (await callAs(svc, svc.seniorId, "GET", "/api/dictionary/stop-lists")).json().items;
  // T291: «Местное» Группы есть с применения Словаря, пустое.
  assert.deepEqual(lists.map((l: { code: string; rows: number }) => [l.code, l.rows]), [["A:local", 0], ["common_defaults", 3]]);
  const p1 = (await callAs(svc, svc.seniorId, "GET", "/api/dictionary/stop-lists/common_defaults/entries?limit=2")).json();
  assert.equal(p1.items.length, 2);
  assert.ok(p1.cursor !== null);
  const p2 = (await callAs(svc, svc.seniorId, "GET", `/api/dictionary/stop-lists/common_defaults/entries?limit=2&cursor=${p1.cursor}`)).json();
  assert.deepEqual([p2.items.length, p2.cursor], [1, null]);
  assert.deepEqual(Object.keys(p1.items[0]).sort(), ["id", "kind", "normalized", "note", "typeId", "value"]);
  assert.equal((await callAs(svc, svc.seniorId, "GET", "/api/dictionary/stop-lists/x/entries")).statusCode, 404);
});

test("T184, DICT-44: курсор страниц вне безопасного целого — 400, а не 500", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  for (const cursor of ["99999999999999999999999", "-1", "1.5", "x"]) {
    for (const path of [`/api/dictionary/stop-lists/common_defaults/entries?cursor=${cursor}`, `/api/indicators?stopList=common_defaults&cursor=${cursor}`]) {
      const res = await callAs(svc, svc.seniorId, "GET", path);
      assert.equal(res.statusCode, 400, `${path}: ${res.body}`);
    }
  }
});

test("T261, DICT-46: предел подачи версии вмещает тело 64 МиБ с экранированием; слишком большой запрос — «больше предела»", async (t) => {
  const { DICTIONARY_BODY_LIMIT } = await import("../../src/api/routes/dictionary.ts");
  const { SLOVAR_MAX_BODY_BYTES } = await import("@aristotel/protocol");
  assert.ok(DICTIONARY_BODY_LIMIT >= 2 * SLOVAR_MAX_BODY_BYTES, "экранированная JSON-строка тела до 64 МиБ проходит");
  const { callAs: call, startTestService: start } = await import("../../../../tests/support/harness.ts");
  const svc = await start(t);
  const res = await call(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "x".repeat(2 * 1024 * 1024) } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /больше предела/);
  assert.doesNotMatch(res.json().message, /корректный JSON/);
});
