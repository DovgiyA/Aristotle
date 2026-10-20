// T035 — JSON API Записей: создание, чтение, изменение, история; удаления и правки истории нет
// (BANK-06, BANK-07, BANK-20, BANK-22; contracts/http-api.md). Значения условные.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUIDv7 } from "node:crypto";
import { startTestService, type TestService } from "../../../../tests/support/harness.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function call(svc: TestService, method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", url: string, payload?: object) {
  const headers: Record<string, string> = { ...svc.authHeaders(svc.seniorId) };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return svc.app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload: payload as Record<string, unknown> });
}

/** В журнале — только записи Членов Группы: служба пишет group-key.create при запуске (фича 003). */
function count(svc: TestService, table: string): number {
  const where = table === "journal" ? " WHERE actorId IS NOT NULL" : "";
  return Number(svc.db.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get()?.["n"]);
}

test("POST /api/records — 201, version 1, Идентификатор UUIDv7 (BANK-20)", async (t) => {
  const svc = await startTestService(t);
  const res = await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } });
  assert.equal(res.statusCode, 201);
  const record = res.json();
  assert.match(record.id, UUID_V7);
  assert.equal(record.type, "test.note");
  assert.equal(record.version, 1);
  assert.deepEqual(record.fields, { x: "v" });
  assert.equal(record.createdBy, svc.seniorId);
  assert.equal(record.updatedBy, svc.seniorId);
  assert.equal(typeof record.createdAt, "string");
});

test("неизвестный тип или поля не по схеме типа — 400 invalid_request, ничего не записано", async (t) => {
  const svc = await startTestService(t);
  for (const body of [{ type: "y", fields: {} }, { type: "test.note", fields: { x: 1 } }, { type: "test.note", fields: { z: "v" } }]) {
    const res = await call(svc, "POST", "/api/records", body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, "invalid_request");
  }
  assert.equal(count(svc, "record"), 0);
  assert.equal(count(svc, "journal"), 0);
});

test("GET /api/records/{id} — 200; нет Записи — 404 not_found", async (t) => {
  const svc = await startTestService(t);
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const got = await call(svc, "GET", `/api/records/${created.id}`);
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.json(), created);
  const missing = await call(svc, "GET", `/api/records/${randomUUIDv7()}`);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, "not_found");
});

test("PATCH — версия +1; без изменений — 200 без истории и журнала; Идентификатор не меняется (BANK-22)", async (t) => {
  const svc = await startTestService(t);
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const changed = await call(svc, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().version, 2);
  assert.equal(changed.json().id, created.id);
  const historyBefore = count(svc, "record_history");
  const journalBefore = count(svc, "journal");
  const same = await call(svc, "PATCH", `/api/records/${created.id}`, { expectedVersion: 2, fields: { x: "w" } });
  assert.equal(same.statusCode, 200);
  assert.equal(same.json().version, 2);
  assert.equal(count(svc, "record_history"), historyBefore);
  assert.equal(count(svc, "journal"), journalBefore);
});

test("PATCH несуществующей Записи — 404, в журнал ничего (edge case)", async (t) => {
  const svc = await startTestService(t);
  const res = await call(svc, "PATCH", `/api/records/${randomUUIDv7()}`, { expectedVersion: 1, fields: { x: "w" } });
  assert.equal(res.statusCode, 404);
  assert.equal(count(svc, "journal"), 0);
});

test("GET /api/records/{id}/history — строки «было — стало» по возрастанию seq (BANK-07)", async (t) => {
  const svc = await startTestService(t);
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  await call(svc, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } });
  const res = await call(svc, "GET", `/api/records/${created.id}/history`);
  assert.equal(res.statusCode, 200);
  const items = res.json().items as Array<Record<string, unknown>>;
  assert.deepEqual(
    items.map(({ version, field, before, after, authorId }) => ({ version, field, before, after, authorId })),
    [
      { version: 1, field: "x", before: null, after: "v", authorId: svc.seniorId },
      { version: 2, field: "x", before: "v", after: "w", authorId: svc.seniorId },
    ],
  );
  const seqs = items.map((i) => Number(i["seq"]));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("удаления Записи и правки истории в API нет (BANK-06)", async (t) => {
  const svc = await startTestService(t);
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  for (const [method, url] of [
    ["DELETE", `/api/records/${created.id}`],
    ["PATCH", `/api/records/${created.id}/history`],
    ["DELETE", `/api/records/${created.id}/history`],
    ["PUT", `/api/records/${created.id}/history`],
  ] as const) {
    const res = await call(svc, method, url, method === "DELETE" ? undefined : {});
    assert.ok([404, 405].includes(res.statusCode), `${method} ${url}: ${res.statusCode}`);
  }
  assert.equal(count(svc, "record"), 1);
  assert.equal(count(svc, "record_history"), 1);
});

// T024 фичи 002 — Наблюдатель только читает (ROLE-07, ROLE-16): изменение — 403 forbidden и для
// существующей, и для несуществующей Записи; чтение Записи без метки и её истории — 200.
test("Наблюдатель: POST и PATCH — 403 forbidden, ответ не зависит от того, есть ли Запись", async (t) => {
  const svc = await startTestService(t);
  const n1 = svc.addMember("Н1", "observer");
  const asObserver = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
    const headers: Record<string, string> = { ...svc.authHeaders(n1) };
    if (payload !== undefined) headers["content-type"] = "application/json";
    return svc.app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload: payload as Record<string, unknown> });
  };
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const journalBefore = count(svc, "journal");

  const create = await asObserver("POST", "/api/records", { type: "test.note", fields: { x: "w" } });
  assert.equal(create.statusCode, 403);
  assert.equal(create.json().error, "forbidden");
  const existing = await asObserver("PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } });
  const missing = await asObserver("PATCH", `/api/records/${randomUUIDv7()}`, { expectedVersion: 1, fields: { x: "w" } });
  assert.equal(existing.statusCode, 403);
  assert.deepEqual(existing.json(), missing.json());
  assert.equal(count(svc, "journal"), journalBefore);

  const read = await asObserver("GET", `/api/records/${created.id}`);
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().fields, { x: "v" });
  const history = await asObserver("GET", `/api/records/${created.id}/history`);
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().items.length, 1);
});

// T051 фичи 002 — имена полей с «$» заняты метками программы: их нельзя сохранить и через тип с
// открытыми полями (research R2, ROLE-24; ревью кода 2026-10-17).
test("поле «$…» в fields — 400 invalid_request при создании и изменении, ничего не записано", async (t) => {
  const svc = await startTestService(t);
  const { Type } = await import("typebox");
  const { registerRecordType, unregisterRecordType } = await import("@aristotel/core");
  registerRecordType({ name: "test.open", fields: Type.Object({}, { additionalProperties: true }), indexText: () => "" });
  t.after(() => unregisterRecordType("test.open"));
  const before = [count(svc, "record"), count(svc, "record_history"), count(svc, "journal")];
  const created = await call(svc, "POST", "/api/records", { type: "test.open", fields: { $secret: false }, secret: true });
  assert.equal(created.statusCode, 400);
  assert.equal(created.json().error, "invalid_request");
  assert.match(created.json().message, /\$secret/);
  assert.deepEqual([count(svc, "record"), count(svc, "record_history"), count(svc, "journal")], before);
  const plain = (await call(svc, "POST", "/api/records", { type: "test.open", fields: { x: "v" } })).json();
  const patched = await call(svc, "PATCH", `/api/records/${plain.id}`, { expectedVersion: 1, fields: { $x: "w" } });
  assert.equal(patched.statusCode, 400);
});
