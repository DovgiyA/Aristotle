// T026 фичи 003 — Ключи Координатора по contracts/http-api.md: регистрация с доказательством
// владения, не больше одного ключа у Старшего, ключ за автором запроса, снятие, список; права
// (NET-13, NET-15, NET-53, FR-016; research R7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { coordinatorKeyProofMessage, keyFingerprint } from "@aristotel/protocol";
import { groupKeyPath } from "@aristotel/core";
import {
  callAs,
  groupA,
  insertRegistryVersion,
  registryDocument,
  restartTestService,
  signDocument,
  startTestService,
  testCoordinatorKey,
  type TestCoordinatorKey,
  type TestService,
} from "../../../../tests/support/harness.ts";

function register(svc: TestService, memberId: string, key: TestCoordinatorKey, proofOf = memberId, installId = svc.install.installId) {
  const sig = Buffer.from(key.sign(coordinatorKeyProofMessage(installId, proofOf))).toString("base64").replace(/=+$/, "");
  return callAs(svc, memberId, "POST", "/api/coordinator-keys", { publicKey: key.publicKey, proof: sig });
}

test("регистрация: 201, ключ за автором, журнал; доказательство над чужими данными — 422", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const k1 = testCoordinatorKey(1);

  assert.equal((await register(svc, a.c1, k1, a.c2 as string)).statusCode, 422);
  assert.equal((await register(svc, a.c1, k1, a.c1, "другая-установка")).json().error, "coordinator_key_proof_invalid");

  const res = await register(svc, a.c1, k1);
  assert.equal(res.statusCode, 201, res.body);
  const item = res.json();
  assert.equal(item.publicKey, k1.publicKey);
  assert.equal(item.keyFingerprint, keyFingerprint(k1.publicKey));
  assert.deepEqual(item.member, { id: a.c1, label: "С1" });
  assert.equal(item.state, "registered");
  assert.equal(item.withdrawnAt, null);
  assert.equal(item.inCurrentRegistry, false);
  const journal = svc.db.prepare("SELECT actorId, subjectType, details FROM journal WHERE action = 'coordinator-key.register'").all();
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.["actorId"], a.c1);
  assert.equal(journal[0]?.["subjectType"], "coordinator-key");
  assert.deepEqual(JSON.parse(String(journal[0]?.["details"])), { keyFingerprint: keyFingerprint(k1.publicKey) });

  // Второй ключ С1 — 409; ключ С1 от имени С2 — 409 (ключ уже за другим Членом Группы).
  assert.equal((await register(svc, a.c1, testCoordinatorKey(2))).json().error, "coordinator_key_exists");
  assert.equal((await register(svc, a.c2 as string, k1)).json().error, "coordinator_key_exists");
  // Участник и Наблюдатель — 403.
  for (const who of [a.u1, a.n1]) assert.equal((await register(svc, who, testCoordinatorKey(3))).statusCode, 403);

  const list = (await callAs(svc, a.n1, "GET", "/api/coordinator-keys")).json().items;
  assert.equal(list.length, 1);
  assert.equal(list[0].publicKey, k1.publicKey);
});

test("снятие своего ключа, повтор — 409; после снятия — новый ключ", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  assert.equal((await register(svc, a.c1, testCoordinatorKey(1))).statusCode, 201);
  assert.equal((await callAs(svc, a.u1, "POST", "/api/coordinator-keys/withdraw", {})).statusCode, 403);
  const res = await callAs(svc, a.c1, "POST", "/api/coordinator-keys/withdraw", {});
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, "withdrawn");
  assert.equal(typeof res.json().withdrawnAt, "string");
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'coordinator-key.withdraw'").get()?.["n"], 1);
  assert.equal((await callAs(svc, a.c1, "POST", "/api/coordinator-keys/withdraw", {})).json().error, "coordinator_key_missing");
  assert.equal((await callAs(svc, a.c2 as string, "POST", "/api/coordinator-keys/withdraw", {})).json().error, "coordinator_key_missing");
  assert.equal((await register(svc, a.c1, testCoordinatorKey(2))).statusCode, 201);
  // Прежний ключ снят навсегда: зарегистрировать его снова нельзя.
  assert.equal((await register(svc, a.c2 as string, testCoordinatorKey(1))).json().error, "coordinator_key_exists");
});

test("Ключ Группы недоступен — регистрация 409 group_key_unavailable, снятие своего ключа — 200 (NET-53; T063)", async (t) => {
  let svc = await startTestService(t);
  const k1 = testCoordinatorKey(1);
  assert.equal((await register(svc, svc.seniorId, k1)).statusCode, 201);
  insertRegistryVersion(svc.db, signDocument(registryDocument(svc.db, { coordinatorKeys: [k1.publicKey] }), k1), svc.seniorId);
  rmSync(groupKeyPath(svc.dir));
  svc = await restartTestService(t, svc);
  assert.equal((await register(svc, svc.seniorId, testCoordinatorKey(2))).json().error, "group_key_unavailable");
  assert.equal((await callAs(svc, svc.seniorId, "GET", "/api/coordinator-keys")).statusCode, 200);
  // Снять свой ключ можно и без Ключа Группы: подписывать ничего не нужно (research R10).
  const withdrawn = await callAs(svc, svc.seniorId, "POST", "/api/coordinator-keys/withdraw", {});
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  assert.equal(withdrawn.json().state, "withdrawn");
});
