// T030 — сценарий 17, шаг 17.4 через API (маска и сводки — фича 011): У1 и С1 читают Секрет-Запись
// целиком без записи в журнал; у Н1 её нет без следа; ставший Наблюдателем сразу теряет доступ
// (ROLE-06 — Старший видит всё содержимое Банка, ROLE-07, ROLE-16, ROLE-23, INBOX-31, VIEW-16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUIDv7 } from "node:crypto";
import { callAs, countRows, groupA, setRole, startTestService } from "../../support/harness.ts";

test("17.4: У1 и С1 читают Секрет-Запись без журнала; Н1 её не видит", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const secret = (await callAs(svc, a.u2, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true })).json();
  const journalBefore = countRows(svc.db, "journal");
  for (const reader of [a.u1, a.c1]) {
    const res = await callAs(svc, reader, "GET", `/api/records/${secret.id}`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().fields, { x: "v" });
    assert.equal((await callAs(svc, reader, "GET", `/api/records/${secret.id}/history`)).statusCode, 200);
  }
  assert.equal(countRows(svc.db, "journal"), journalBefore, "чтение не журналируется (INBOX-31)");

  const ghost = randomUUIDv7();
  for (const suffix of ["", "/history"]) {
    const seen = await callAs(svc, a.n1, "GET", `/api/records/${secret.id}${suffix}`);
    const absent = await callAs(svc, a.n1, "GET", `/api/records/${ghost}${suffix}`);
    assert.equal(seen.statusCode, 404);
    assert.equal(seen.body.replaceAll(secret.id, "ID"), absent.body.replaceAll(ghost, "ID"));
  }
});

test("17.4, Edge Cases: ставший Наблюдателем сразу теряет доступ к Секрет-Записи, которую сам пометил", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const created = (await callAs(svc, a.u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  await callAs(svc, a.u1, "POST", `/api/records/${created.id}/secret/mark`, { expectedVersion: 1 });
  assert.equal((await callAs(svc, a.u1, "GET", `/api/records/${created.id}`)).statusCode, 200);
  setRole(svc.db, a.u1, "observer");
  assert.equal((await callAs(svc, a.u1, "GET", `/api/records/${created.id}`)).statusCode, 404);
});
