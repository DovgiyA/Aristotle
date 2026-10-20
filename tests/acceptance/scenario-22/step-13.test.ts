// T069 — шаг 22.13 в части признака: Запись копии с типом из версии n+1 при применённой n — признак
// «тип из версии n+1, у вас n»; после применения n+1 тип на месте (DICT-20). Копии чужих Записей —
// фича 022: копия подставлена тестом в БД.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase, createTestObject, nextTestVersion, signWithTestCoordinator, T } from "../../support/dictionary.ts";

test("22.13: typeFromNewerVersion = { version: 2, known: 1 }; после версии 2 — null", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const NEW = "0190a000-0000-7000-8000-0000000a0002";
  const at = new Date().toISOString();
  svc.db.prepare("INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES ('copy-1', 'indicator', 1, ?, ?, ?, ?, ?, 0)").run(
    JSON.stringify({ object: op.id, type: NEW, value: "x", source: { kind: "manual" }, verified: true, case: c.id, dictionaryVersion: 2 }),
    at,
    at,
    u1,
    u1,
  );
  assert.deepEqual((await callAs(svc, u1, "GET", "/api/records/copy-1")).json().view.typeFromNewerVersion, { version: 2, known: 1 });
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) =>
      b.elements.push({ id: NEW, code: "x_new", label: "x", kind: "indicator_type", state: "active", sinceVersion: 2, props: { object: T.object("operator"), format: "строка:64", comparable: false, normClass: "строка", identifying: "none", autoSecret: false } }),
    ),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  assert.equal((await callAs(svc, u1, "GET", "/api/records/copy-1")).json().view.typeFromNewerVersion, null);
});

test("T113: признак «тип из версии N» — и у объекта (вид), и у связи (тип связи)", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const at = new Date().toISOString();
  const insert = (id: string, type: string, fields: Record<string, unknown>) =>
    svc.db.prepare("INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0)").run(id, type, JSON.stringify(fields), at, at, u1, u1);
  insert("copy-obj", "object", { kind: "0190a000-0000-7000-8000-0000000a0003", case: c.id, dictionaryVersion: 2 });
  insert("copy-link", "link", { type: "0190a000-0000-7000-8000-0000000a0004", from: op.id, to: "copy-obj", confidence: "low", author: u1, source: { kind: "manual" }, case: c.id, dictionaryVersion: 3 });
  assert.deepEqual((await callAs(svc, u1, "GET", "/api/records/copy-obj")).json().view.typeFromNewerVersion, { version: 2, known: 1 });
  assert.deepEqual((await callAs(svc, u1, "GET", "/api/records/copy-link")).json().view.typeFromNewerVersion, { version: 3, known: 1 });
  assert.equal((await callAs(svc, u1, "GET", `/api/records/${op.id}`)).json().view.typeFromNewerVersion, null);
});
