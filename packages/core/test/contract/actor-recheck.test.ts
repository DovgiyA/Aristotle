// T050 — право и состояние автора перепроверяются в транзакции изменения: автора отзывают или
// снимают с роли после хука onRequest, но до обработчика, — запрос ничего не меняет (FR-004,
// FR-005, STATION-17; ревью кода 2026-10-17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMember } from "@aristotel/core";
import { callAs, countRows, setRole, startTestService, type TestService } from "../../../../tests/support/harness.ts";

const TABLES = ["member", "record", "record_history", "journal"] as const;

/** Между хуком прав и обработчиком: заголовок x-test-race говорит, что сделать с автором. */
function raceHook(svc: TestService): void {
  svc.app.addHook("preHandler", async (request) => {
    const race = request.headers["x-test-race"];
    if (race === "revoke") svc.db.prepare("UPDATE member SET state = 'revoked', version = version + 1 WHERE id = ?").run(request.memberId);
    if (race === "observer") setRole(svc.db, request.memberId, "observer");
  });
}

async function racing(svc: TestService, as: string, race: string, method: "POST" | "PATCH", url: string, payload: unknown) {
  return svc.app.inject({
    method,
    url,
    headers: { ...svc.authHeaders(as), "content-type": "application/json", "x-test-race": race },
    payload: payload as Record<string, unknown>,
  });
}

function snapshot(svc: TestService): number[] {
  return TABLES.map((table) => countRows(svc.db, table));
}

test("Старшего отзывают, пока идёт его POST /api/members, — 403 member_revoked, никого не заведено", async (t) => {
  const svc = await startTestService(t);
  raceHook(svc);
  const c2 = svc.addMember("С2", "senior");
  const before = snapshot(svc);
  const res = await racing(svc, c2, "revoke", "POST", "/api/members", { label: "С3", role: "participant" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "member_revoked");
  // Изменилась только сама запись отозванного (её меняет стенд), журнал и состав — нет.
  assert.deepEqual(snapshot(svc), before);
});

test("Участника переводят в Наблюдатели, пока идут его изменения, — 403 forbidden, ничего не меняется", async (t) => {
  const svc = await startTestService(t);
  raceHook(svc);
  const created = (await callAs(svc, svc.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json();
  const cases: [string, "POST" | "PATCH", string, unknown][] = [
    ["mark", "POST", `/api/records/${created.id}/secret/mark`, { expectedVersion: 1 }],
    ["update", "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } }],
    ["create", "POST", "/api/records", { type: "test.note", fields: { x: "y" } }],
  ];
  for (const [name, method, url, payload] of cases) {
    const u1 = svc.addMember(`У-${name}`);
    const before = snapshot(svc);
    const res = await racing(svc, u1, "observer", method, url, payload);
    assert.equal(res.statusCode, 403, name);
    assert.equal(res.json().error, "forbidden", name);
    assert.deepEqual(snapshot(svc), before, name);
  }
});

test("Старшего снимают с роли, пока идут его PATCH и revoke Члена Группы, — 403 forbidden", async (t) => {
  const svc = await startTestService(t);
  raceHook(svc);
  const c2 = svc.addMember("С2", "senior");
  const u1 = svc.addMember("У1");
  for (const [method, url, payload] of [
    ["PATCH", `/api/members/${u1}`, { expectedVersion: 1, label: "x" }],
    ["POST", `/api/members/${u1}/revoke`, { expectedVersion: 1 }],
  ] as const) {
    setRole(svc.db, c2, "senior");
    const journal = countRows(svc.db, "journal");
    const res = await racing(svc, c2, "observer", method, url, payload);
    assert.equal(res.statusCode, 403, url);
    assert.equal(countRows(svc.db, "journal"), journal, url);
  }
  const target = svc.db.prepare("SELECT label, state FROM member WHERE id = ?").get(u1);
  assert.deepEqual([target?.["label"], target?.["state"]], ["У1", "active"]);
});

test("ядро без API: createMember от имени отозванного — member_revoked", async (t) => {
  const svc = await startTestService(t);
  const c2 = svc.addMember("С2", "senior");
  svc.db.prepare("UPDATE member SET state = 'revoked' WHERE id = ?").run(c2);
  assert.throws(() => createMember(svc.db, { label: "У9", role: "participant" }, c2), { code: "member_revoked" });
});
