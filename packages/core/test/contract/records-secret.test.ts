// T027 — метка Секрет на Записи: создание Секретом, mark и unmark с историей «$secret» и журналом,
// права ROLE-17 и ROLE-18, видимость для Наблюдателя без следа (ROLE-24, VIEW-16; research R2, R3;
// contracts/http-api.md фичи 002).
// Журнал в проверках — записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUIDv7 } from "node:crypto";
import { callAs, countRows, startTestService, type TestService } from "../../../../tests/support/harness.ts";

function journal(svc: TestService) {
  return svc.db
    .prepare("SELECT action, subjectId, historyFrom, historyTo, details FROM journal WHERE actorId IS NOT NULL ORDER BY seq")
    .all()
    .map((r) => ({
      action: String(r["action"]),
      subjectId: String(r["subjectId"]),
      historyFrom: r["historyFrom"],
      historyTo: r["historyTo"],
      details: r["details"] === null ? null : (JSON.parse(String(r["details"])) as unknown),
    }));
}

function history(svc: TestService, id: string) {
  return svc.db
    .prepare("SELECT seq, version, field, before, after FROM record_history WHERE recordId = ? ORDER BY seq")
    .all(id)
    .map((r) => [r["version"], r["field"], r["before"] === null ? null : JSON.parse(String(r["before"])), JSON.parse(String(r["after"]))]);
}

test("POST /api/records с secret: true — Запись Секрет, строка $secret версии 1, журнал с details.secret", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true });
  assert.equal(res.statusCode, 201);
  const record = res.json();
  assert.equal(record.secret, true);
  assert.deepEqual(history(svc, record.id), [
    [1, "x", null, "v"],
    [1, "$secret", null, true],
  ]);
  assert.deepEqual(
    journal(svc).map((j) => [j.action, j.details]),
    [["record.create", { secret: true }]],
  );
  const plain = (await callAs(svc, u1, "POST", "/api/records", { type: "test.note", fields: { x: "w" } })).json();
  assert.equal(plain.secret, false);
  assert.equal(journal(svc)[1]?.details, null);
});

test("mark и unmark: версия +1, строка $secret, журнал record.secret.mark/unmark с диапазоном истории", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const created = (await callAs(svc, u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const url = `/api/records/${created.id}/secret`;

  const marked = await callAs(svc, u1, "POST", `${url}/mark`, { expectedVersion: 1 });
  assert.equal(marked.statusCode, 200);
  assert.equal(marked.json().secret, true);
  assert.equal(marked.json().version, 2);
  assert.equal(marked.json().updatedBy, u1);

  const unmarked = await callAs(svc, svc.seniorId, "POST", `${url}/unmark`, { expectedVersion: 2 });
  assert.equal(unmarked.statusCode, 200);
  assert.equal(unmarked.json().secret, false);
  assert.equal(unmarked.json().version, 3);

  assert.deepEqual(history(svc, created.id), [
    [1, "x", null, "v"],
    [2, "$secret", false, true],
    [3, "$secret", true, false],
  ]);
  const entries = journal(svc);
  assert.deepEqual(entries.map((j) => j.action), ["record.create", "record.secret.mark", "record.secret.unmark"]);
  const seqs = svc.db.prepare("SELECT seq FROM record_history WHERE field = '$secret' ORDER BY seq").all().map((r) => r["seq"]);
  assert.deepEqual([entries[1]?.historyFrom, entries[1]?.historyTo], [seqs[0], seqs[0]]);
  assert.deepEqual([entries[2]?.historyFrom, entries[2]?.historyTo], [seqs[1], seqs[1]]);
});

test("метка уже в нужном состоянии — 200 без истории и журнала; устаревшая версия — 409", async (t) => {
  const svc = await startTestService(t);
  const created = (await callAs(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const url = `/api/records/${created.id}/secret`;
  const before = [countRows(svc.db, "record_history"), countRows(svc.db, "journal")];
  const noop = await callAs(svc, svc.seniorId, "POST", `${url}/unmark`, { expectedVersion: 1 });
  assert.equal(noop.statusCode, 200);
  assert.equal(noop.json().version, 1);
  assert.deepEqual([countRows(svc.db, "record_history"), countRows(svc.db, "journal")], before);

  await callAs(svc, svc.seniorId, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } });
  const stale = await callAs(svc, svc.seniorId, "POST", `${url}/mark`, { expectedVersion: 1 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, "version_conflict");
  assert.equal(stale.json().current.version, 2);
  const missing = await callAs(svc, svc.seniorId, "POST", `/api/records/${randomUUIDv7()}/secret/mark`, { expectedVersion: 1 });
  assert.equal(missing.statusCode, 404);
});

test("права: Участник снять не может, Наблюдатель — ни поставить, ни снять (ROLE-17, ROLE-18)", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const n1 = svc.addMember("Н1", "observer");
  const created = (await callAs(svc, u1, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true })).json();
  const url = `/api/records/${created.id}/secret`;
  for (const [as, action] of [[u1, "unmark"], [n1, "mark"], [n1, "unmark"]] as const) {
    const res = await callAs(svc, as, "POST", `${url}/${action}`, { expectedVersion: 1 });
    assert.equal(res.statusCode, 403, `${action}`);
    assert.equal(res.json().error, "forbidden");
  }
  const observerCreates = await callAs(svc, n1, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true });
  assert.equal(observerCreates.statusCode, 403);
});

test("Наблюдателю Секрет-Запись и её история — 404 с тем же телом, что для несуществующей (VIEW-16)", async (t) => {
  const svc = await startTestService(t);
  const n1 = svc.addMember("Н1", "observer");
  const secret = (await callAs(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" }, secret: true })).json();
  const ghost = randomUUIDv7();
  for (const suffix of ["", "/history"]) {
    const seen = await callAs(svc, n1, "GET", `/api/records/${secret.id}${suffix}`);
    const absent = await callAs(svc, n1, "GET", `/api/records/${ghost}${suffix}`);
    assert.equal(seen.statusCode, 404);
    assert.equal(absent.statusCode, 404);
    assert.equal(seen.body.replaceAll(secret.id, "ID"), absent.body.replaceAll(ghost, "ID"));
    assert.deepEqual(Object.keys(seen.json()).sort(), ["error", "message"]);
  }
  // Старший видит.
  assert.equal((await callAs(svc, svc.seniorId, "GET", `/api/records/${secret.id}`)).statusCode, 200);
});
