// Ревью, P2 — ошибки библиотек (Fastify, AJV, TypeBox) не доходят до людей по-английски, а
// некорректный JSON — клиентская ошибка 400 (конституция VIII, APP-09; contracts/http-api.md).
// Журнал в проверках — записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService, type TestService } from "../../../../tests/support/harness.ts";

const ENGLISH = /\b(must|NOT|characters|property|Body|valid|schema|expected)\b/;

function send(svc: TestService, method: "POST" | "GET", url: string, payload?: unknown, contentType = "application/json") {
  const headers: Record<string, string> = { ...svc.authHeaders(svc.seniorId) };
  if (payload !== undefined) headers["content-type"] = contentType;
  return svc.app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload: payload as string });
}

function assertRussian400(res: { statusCode: number; json: () => { error: string; message: string } }, expected: RegExp): void {
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, "invalid_request");
  assert.match(body.message, expected);
  assert.doesNotMatch(body.message, ENGLISH, body.message);
}

test("пустая подпись первого Старшего — русское сообщение о длине", async (t) => {
  const svc = await startTestService(t, { emptyGroup: true });
  const res = await svc.maintenance.inject({
    method: "POST",
    url: "/api/members/bootstrap",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${svc.token}`, "content-type": "application/json" },
    payload: { label: "", osAccount: "u" },
  });
  assertRussian400(res, /label.*не короче 1/);
});

test("нет обязательного поля — русское сообщение с именем поля", async (t) => {
  const svc = await startTestService(t);
  assertRussian400(await send(svc, "POST", "/api/records", JSON.stringify({ type: "test.note" })), /нет обязательного поля fields/);
});

test("поле Записи не того типа — русское сообщение TypeBox", async (t) => {
  const svc = await startTestService(t);
  assertRussian400(await send(svc, "POST", "/api/records", JSON.stringify({ type: "test.note", fields: { x: 1 } })), /x.*строка/);
  assertRussian400(await send(svc, "POST", "/api/records", JSON.stringify({ type: "test.note", fields: { z: "v" } })), /лишнее поле z/);
});

test("параметр запроса вне границ — русское сообщение", async (t) => {
  const svc = await startTestService(t);
  assertRussian400(await send(svc, "GET", "/api/journal?limit=0"), /limit.*не меньше 1/);
});

test("некорректный JSON и чужой тип содержимого — 400 invalid_request, не 500", async (t) => {
  const svc = await startTestService(t);
  assertRussian400(await send(svc, "POST", "/api/records", "{"), /JSON/);
  const plain = await send(svc, "POST", "/api/records", "x", "text/plain");
  assert.equal(plain.statusCode, 400);
  assert.doesNotMatch(plain.json().message, ENGLISH);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE actorId IS NOT NULL").get()?.["n"], 0);
});
