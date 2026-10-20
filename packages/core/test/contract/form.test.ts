// T058 — контракт GET /api/form и GET /api/report-skeleton (contracts/http-api.md фичи 005;
// конституция III; DATA-23): схемы ответов, неизвестный Класс или подтип не того Класса — 400, право
// record.read, Наблюдатель читает.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../../../tests/support/harness.ts";
import { applyTestDictionary } from "../../../../tests/support/dictionary.ts";

test("схемы ответов; Наблюдатель читает", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const h1 = svc.addMember("Н1", "observer");
  const f = (await callAs(svc, h1, "GET", "/api/form?class=companion")).json();
  assert.deepEqual(Object.keys(f).sort(), ["blocks", "class", "general", "subtype"]);
  assert.deepEqual(Object.keys(f.blocks[0].fields[0]).sort(), ["defaultSource", "deprecated", "format", "formats", "label", "local", "required", "target"]);
  assert.deepEqual(Object.keys(f.general[0]).sort(), ["code", "defaultSource", "field", "label", "required"]);
  const r = (await callAs(svc, h1, "GET", "/api/report-skeleton?class=companion")).json();
  assert.deepEqual(Object.keys(r), ["sections"]);
});

test("неизвестный Класс, подтип без шаблона у Класса — 400 invalid_request; без Словаря — 409", async (t) => {
  const svc = await startTestService(t);
  assert.equal((await callAs(svc, svc.seniorId, "GET", "/api/form?class=companion")).json().error, "dictionary_missing");
  await applyTestDictionary(svc);
  assert.deepEqual([(await callAs(svc, svc.seniorId, "GET", "/api/form?class=x")).statusCode, (await callAs(svc, svc.seniorId, "GET", "/api/form?class=x")).json().error], [400, "invalid_request"]);
  assert.equal((await callAs(svc, svc.seniorId, "GET", "/api/form?class=companion&subtype=x")).statusCode, 400);
});
