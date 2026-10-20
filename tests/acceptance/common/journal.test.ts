// T036 — общие условия сценариев: журнал пишет каждое изменение, чтение — нет
// (INBOX-30, INBOX-31, SC-001).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService, type TestService } from "../../support/harness.ts";

function call(svc: TestService, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  const headers: Record<string, string> = { ...svc.authHeaders(svc.seniorId) };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return svc.app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload: payload as Record<string, unknown> });
}

test("каждое создание и изменение — ровно одна запись журнала со ссылкой на историю", async (t) => {
  const svc = await startTestService(t);
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  let version = created.version as number;
  for (const value of ["w", "y", "v"]) {
    version = (await call(svc, "PATCH", `/api/records/${created.id}`, { expectedVersion: version, fields: { x: value } })).json().version;
  }
  // Записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
  const journal = svc.db.prepare("SELECT actorId, action, subjectId, historyFrom, historyTo FROM journal WHERE actorId IS NOT NULL ORDER BY seq").all();
  assert.deepEqual(
    journal.map((j) => j["action"]),
    ["record.create", "record.update", "record.update", "record.update"],
  );
  for (const entry of journal) {
    assert.equal(entry["actorId"], svc.seniorId);
    assert.equal(entry["subjectId"], created.id);
    assert.equal(typeof entry["historyFrom"], "number");
    assert.equal(typeof entry["historyTo"], "number");
  }
  // SC-001: каждая строка истории покрыта ровно одной записью журнала.
  const uncovered = svc.db
    .prepare(
      `SELECT h.seq FROM record_history h
       WHERE (SELECT count(*) FROM journal j WHERE h.seq BETWEEN j.historyFrom AND j.historyTo) <> 1`,
    )
    .all();
  assert.deepEqual(uncovered, []);
});

test("чтение Записи и её истории в журнал не пишется (INBOX-31)", async (t) => {
  const svc = await startTestService(t);
  const created = (await call(svc, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const before = svc.db.prepare("SELECT count(*) AS n FROM journal").get()?.["n"];
  await call(svc, "GET", `/api/records/${created.id}`);
  await call(svc, "GET", `/api/records/${created.id}/history`);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal").get()?.["n"], before);
});
