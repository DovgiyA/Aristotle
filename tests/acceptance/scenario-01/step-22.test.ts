// T044 — сценарий 1, шаг 1.22 через API: У1 и У2 правят одну Запись, У2 сохраняет вторым —
// сохранение отклонено, У2 видит изменения У1 и переносит правку (BANK-09, SC-003).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService, type TestService } from "../../support/harness.ts";

function as(svc: TestService, memberId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  const headers: Record<string, string> = { ...svc.authHeaders(memberId) };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return svc.app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload: payload as Record<string, unknown> });
}

test("1.22: сохранение У2 поверх устаревшей версии отклонено, У2 переносит правку", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  const created = (await as(svc, u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const url = `/api/records/${created.id}`;

  // Оба открыли Запись в версии 1.
  const seenByU1 = (await as(svc, u1, "GET", url)).json();
  const seenByU2 = (await as(svc, u2, "GET", url)).json();
  assert.equal(seenByU1.version, 1);
  assert.equal(seenByU2.version, 1);

  assert.equal((await as(svc, u1, "PATCH", url, { expectedVersion: seenByU1.version, fields: { x: "w" } })).statusCode, 200);

  const rejected = await as(svc, u2, "PATCH", url, { expectedVersion: seenByU2.version, fields: { x: "y" } });
  assert.equal(rejected.statusCode, 409);
  const conflict = rejected.json();
  assert.equal(conflict.error, "version_conflict");
  // У2 видит изменения У1.
  assert.equal(conflict.current.version, 2);
  assert.deepEqual(conflict.current.fields, { x: "w" });
  assert.deepEqual(
    conflict.changesSince.map((c: Record<string, unknown>) => [c["field"], c["before"], c["after"], c["authorId"]]),
    [["x", "v", "w", u1]],
  );
  // Запись содержит только изменение У1.
  assert.deepEqual((await as(svc, u1, "GET", url)).json().fields, { x: "w" });

  // У2 переносит правку на текущую версию.
  const retried = await as(svc, u2, "PATCH", url, { expectedVersion: conflict.current.version, fields: { x: "y" } });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().version, 3);
  const history = (await as(svc, u1, "GET", `${url}/history`)).json().items as Array<Record<string, unknown>>;
  assert.deepEqual(
    history.map((h) => [h["version"], h["after"], h["authorId"]]),
    [
      [1, "v", u1],
      [2, "w", u1],
      [3, "y", u2],
    ],
  );
});

test("SC-003: из 100 сохранений поверх устаревшей версии отклонены все 100, изменения не потеряны", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  const created = (await as(svc, u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const url = `/api/records/${created.id}`;
  let rejected = 0;
  for (let i = 0; i < 100; i++) {
    const version = (await as(svc, u2, "GET", url)).json().version;
    await as(svc, u1, "PATCH", url, { expectedVersion: version, fields: { x: `w${i}` } });
    const stale = await as(svc, u2, "PATCH", url, { expectedVersion: version, fields: { x: `y${i}` } });
    if (stale.statusCode === 409) rejected++;
  }
  assert.equal(rejected, 100);
  const history = (await as(svc, u1, "GET", `${url}/history`)).json().items as Array<Record<string, unknown>>;
  assert.equal(history.filter((h) => h["authorId"] === u1 && String(h["after"]).startsWith("w")).length, 100);
  assert.equal(history.filter((h) => h["authorId"] === u2).length, 0);
  assert.deepEqual((await as(svc, u1, "GET", url)).json().fields, { x: "w99" });
});
