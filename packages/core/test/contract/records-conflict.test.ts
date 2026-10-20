// T045 — 409 version_conflict: current и changesSince после expectedVersion (BANK-09; contracts/http-api.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService, type TestService } from "../../../../tests/support/harness.ts";

function call(svc: TestService, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  const headers: Record<string, string> = { ...svc.authHeaders(svc.seniorId) };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return svc.app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload: payload as Record<string, unknown> });
}

async function recordAtVersion3(svc: TestService) {
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const url = `/api/records/${created.id}`;
  await call(svc, "PATCH", url, { expectedVersion: 1, fields: { x: "w" } });
  await call(svc, "PATCH", url, { expectedVersion: 2, fields: { x: "y" } });
  return { id: created.id as string, url };
}

test("409: current — текущая Запись, changesSince — строки истории после expectedVersion по seq", async (t) => {
  const svc = await startTestService(t);
  const { url } = await recordAtVersion3(svc);
  const res = await call(svc, "PATCH", url, { expectedVersion: 1, fields: { x: "z" } });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error, "version_conflict");
  assert.match(body.message, /Перенесите правку на текущую версию/);
  assert.equal(body.current.version, 3);
  assert.deepEqual(body.current.fields, { x: "y" });
  assert.deepEqual(
    body.changesSince.map((c: Record<string, unknown>) => [c["version"], c["before"], c["after"]]),
    [
      [2, "v", "w"],
      [3, "w", "y"],
    ],
  );
  const seqs = body.changesSince.map((c: Record<string, unknown>) => Number(c["seq"]));
  assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b));
});

test("после отказа Запись, история и журнал не изменились", async (t) => {
  const svc = await startTestService(t);
  const { url } = await recordAtVersion3(svc);
  const n = (table: string) => Number(svc.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
  const before = [n("record_history"), n("journal")];
  await call(svc, "PATCH", url, { expectedVersion: 2, fields: { x: "z" } });
  assert.deepEqual([n("record_history"), n("journal")], before);
  assert.deepEqual((await call(svc, "GET", url)).json().fields, { x: "y" });
});

test("устаревшая версия отклоняется даже без изменений; версия из будущего — тоже конфликт", async (t) => {
  const svc = await startTestService(t);
  const { url } = await recordAtVersion3(svc);
  assert.equal((await call(svc, "PATCH", url, { expectedVersion: 2, fields: { x: "y" } })).statusCode, 409);
  assert.equal((await call(svc, "PATCH", url, { expectedVersion: 9, fields: { x: "z" } })).statusCode, 409);
  assert.equal((await call(svc, "PATCH", url, { expectedVersion: 3, fields: { x: "z" } })).statusCode, 200);
});
