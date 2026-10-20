// Ревью, P1 — закодированный путь не обходит версию API, токен и автора: проверка доступа
// привязана к найденному маршруту, а не к сырому URL (FR-014, APP-23; contracts/http-api.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService } from "../../../../tests/support/harness.ts";

const ENCODED = ["/%61pi/journal", "/%61%70%69/journal", "/api/%6Aournal", "/%2561pi/journal"];

test("заведение первого Старшего по закодированному пути без токена — отказ, Старший не заведён", async (t) => {
  const svc = await startTestService(t, { emptyGroup: true });
  for (const url of ["/%61pi/members/bootstrap", "/api/members/%62ootstrap"]) {
    const res = await svc.app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: { label: "С1", osAccount: "u" },
    });
    assert.ok([404, 426].includes(res.statusCode), `${url}: ${res.statusCode}`);
  }
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM member").get()?.["n"], 0);
});

test("журнал и Записи по закодированному пути без заголовков — отказ, данных нет", async (t) => {
  const svc = await startTestService(t);
  const created = (
    await svc.app.inject({
      method: "POST",
      url: "/api/records",
      headers: { ...svc.authHeaders(svc.seniorId), "content-type": "application/json" },
      payload: { type: "test.note", fields: { x: "v" } },
    })
  ).json();
  for (const url of [...ENCODED, `/%61pi/records/${created.id}`, `/%61pi/records/${created.id}/history`]) {
    const res = await svc.app.inject({ method: "GET", url });
    assert.ok([404, 426].includes(res.statusCode), `${url}: ${res.statusCode}`);
    assert.doesNotMatch(res.body, /"items"|"fields"/, url);
  }
});

test("закодированный путь с версией API, но без токена — 401", async (t) => {
  const svc = await startTestService(t);
  const res = await svc.app.inject({ method: "GET", url: "/%61pi/journal", headers: { "aristotel-api-version": "1" } });
  assert.ok([401, 404].includes(res.statusCode), String(res.statusCode));
  assert.doesNotMatch(res.body, /"items"/);
});
