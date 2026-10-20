// T039 — файл БД недоступен на запись или кончилось место: 503, ничего частичного; порядок истории
// и журнала держится на seq, когда часы переведены назад (BANK-05; edge cases spec.md; research R7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService, type TestService } from "../../../../tests/support/harness.ts";

function call(svc: TestService, method: "POST" | "PATCH", url: string, payload: object) {
  return svc.app.inject({
    method,
    url,
    headers: { ...svc.authHeaders(svc.seniorId), "content-type": "application/json" },
    payload: payload as Record<string, unknown>,
  });
}

function snapshot(svc: TestService) {
  const n = (table: string) => Number(svc.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
  return { record: n("record"), history: n("record_history"), journal: n("journal") };
}

test("файл БД только для чтения — 503 storage_unavailable, ничего не записано", async (t) => {
  const svc = await startTestService(t);
  svc.session(svc.seniorId); // сеанс тестовой Станции — до того, как файл станет только для чтения
  const before = snapshot(svc);
  svc.db.exec("PRAGMA query_only = ON");
  const res = await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } });
  svc.db.exec("PRAGMA query_only = OFF");
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "storage_unavailable");
  assert.deepEqual(snapshot(svc), before);
});

test("кончилось место — 503 storage_unavailable, ничего частичного", async (t) => {
  const svc = await startTestService(t);
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const before = snapshot(svc);
  const pages = Number(svc.db.prepare("PRAGMA page_count").get()?.["page_count"]);
  svc.db.exec(`PRAGMA max_page_count = ${pages}`);
  const res = await call(svc, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w".repeat(200_000) } });
  svc.db.exec("PRAGMA max_page_count = 4294967294");
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "storage_unavailable");
  assert.deepEqual(snapshot(svc), before);
  assert.equal(svc.db.prepare("SELECT version FROM record WHERE id = ?").get(created.id)?.["version"], 1);
});

test("часы переведены назад — порядок истории и журнала по seq (research R7)", async (t) => {
  const svc = await startTestService(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-16T12:00:00.000Z") });
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  t.mock.timers.setTime(Date.parse("2026-10-16T11:00:00.000Z"));
  await call(svc, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } });
  t.mock.timers.reset();
  // Записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
  const journal = svc.db.prepare("SELECT action, at FROM journal WHERE actorId IS NOT NULL ORDER BY seq").all();
  assert.deepEqual(journal.map((j) => j["action"]), ["record.create", "record.update"]);
  assert.ok(String(journal[1]?.["at"]) < String(journal[0]?.["at"]), "время второй записи раньше первой");
  const history = svc.db.prepare("SELECT version FROM record_history WHERE recordId = ? ORDER BY seq").all(created.id);
  assert.deepEqual(history.map((h) => h["version"]), [1, 2]);
});
