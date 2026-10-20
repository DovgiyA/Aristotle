// T011 фичи 004 — API сопровождения на loopback (APP-34): что можно CLI на самой Опорной станции, а что
// — только со Станции; автор применённой версии Реестра — владелец подписавшего Ключа Координатора
// (NET-54); регистрация Ключа Координатора — пока нет принятых Станций (research R9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUIDv7 } from "node:crypto";
import { coordinatorKeyProofMessage, serializeSignedDocument } from "@aristotel/protocol";
import {
  type TestCoordinatorKey,
  callMaintenance,
  openTestSession,
  registryDocument,
  signDocument,
  startTestService,
  testCoordinatorKey,
} from "../../../../tests/support/harness.ts";

/** Доказательство владения Ключом Координатора (research R7 фичи 003). */
function coordinatorKeyProof(key: TestCoordinatorKey, installId: string, memberId: string): string {
  return Buffer.from(key.sign(coordinatorKeyProofMessage(installId, memberId))).toString("base64").replace(/=+$/, "");
}

test("маршруты сопровождения отвечают по токену локального доступа без сеанса Станции", async (t) => {
  const svc = await startTestService(t);
  for (const url of ["/api/version", "/api/registry", "/api/group-key", "/api/coordinator-keys"]) {
    assert.equal((await callMaintenance(svc, "GET", url)).statusCode, 200, url);
  }
  const noToken = await svc.maintenance.inject({ method: "GET", url: "/api/registry", headers: { "aristotel-api-version": "1" } });
  assert.equal(noToken.statusCode, 401);
  assert.equal(noToken.json().error, "unauthorized");
});

test("Записи, состав Группы, Секрет, журнал — 403 maintenance_only, Банк не меняется (APP-34)", async (t) => {
  const svc = await startTestService(t);
  const id = (await callMaintenance(svc, "GET", "/api/members")).json();
  const count = () => Number(svc.db.prepare("SELECT count(*) AS n FROM record").get()?.["n"]) + Number(svc.db.prepare("SELECT count(*) AS n FROM member").get()?.["n"]);
  const before = count();
  const attempts: [method: "GET" | "POST" | "PATCH", url: string, body?: object][] = [
    ["POST", "/api/records", { type: "test.note", fields: { x: "v" } }],
    ["PATCH", `/api/records/${randomUUIDv7()}`, { expectedVersion: 1, fields: { x: "w" } }],
    ["POST", "/api/members", { label: "У3", role: "participant" }],
    ["PATCH", `/api/members/${svc.seniorId}`, { expectedVersion: 1, label: "x" }],
    ["POST", `/api/records/${randomUUIDv7()}/secret/unmark`, { expectedVersion: 1 }],
    ["GET", "/api/journal"],
    ["GET", "/api/members"],
  ];
  assert.equal(id.error, "maintenance_only");
  for (const [method, url, body] of attempts) {
    const res = await callMaintenance(svc, method, url, body, svc.seniorId);
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.json().error, "maintenance_only");
    assert.match(res.json().message, /Станции/);
    assert.match(res.json().message, /APP-34/);
  }
  assert.equal(count(), before);
});

test("черновик и применение версии через сопровождение: автор — владелец подписавшего ключа, без присутствия (NET-54)", async (t) => {
  const svc = await startTestService(t);
  const key = testCoordinatorKey(0x31);
  const reg = await callMaintenance(svc, "POST", "/api/coordinator-keys", { publicKey: key.publicKey, proof: coordinatorKeyProof(key, svc.install.installId, svc.seniorId) }, svc.seniorId);
  assert.equal(reg.statusCode, 201, reg.body);
  const draft = await callMaintenance(svc, "POST", "/api/registry/draft", { code: "A", addRelays: [{ url: "https://relay-x.test:8443", tlsSpki: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk" }] });
  assert.equal(draft.statusCode, 200, draft.body);
  const doc = signDocument(registryDocument(svc.db, { coordinatorKeys: [key.publicKey] }), key);
  const applied = await callMaintenance(svc, "POST", "/api/registry/versions", JSON.parse(serializeSignedDocument(doc)));
  assert.equal(applied.statusCode, 201, applied.body);
  const row = svc.db.prepare("SELECT actorId FROM journal WHERE action = 'registry.apply'").get();
  assert.equal(row?.["actorId"], svc.seniorId);
  assert.equal(svc.db.prepare("SELECT appliedBy FROM registry_version WHERE number = 1").get()?.["appliedBy"], svc.seniorId);
});

test("регистрация Ключа Координатора через сопровождение — только пока нет принятых Станций", async (t) => {
  const svc = await startTestService(t);
  openTestSession(svc.db, svc.seniorId);
  const key = testCoordinatorKey(0x32);
  const res = await callMaintenance(svc, "POST", "/api/coordinator-keys", { publicKey: key.publicKey, proof: coordinatorKeyProof(key, svc.install.installId, svc.seniorId) }, svc.seniorId);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "maintenance_only");
});

test("первый Старший — только API сопровождения; на API Станций маршрута нет", async (t) => {
  const svc = await startTestService(t, { emptyGroup: true });
  const body = { label: "С1", osAccount: "u" };
  const station = await svc.rawInject({ method: "POST", url: "/api/members/bootstrap", headers: { "aristotel-api-version": "1", "content-type": "application/json" }, payload: body });
  assert.equal(station.statusCode, 404);
  assert.equal((await callMaintenance(svc, "POST", "/api/members/bootstrap", body)).statusCode, 201);
});
