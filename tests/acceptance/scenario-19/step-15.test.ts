// T038 фичи 003 — сценарий 19, шаг 19.15: Н1 видит Реестр — номер версии, Координирующую Группу,
// свою запись с Кодом, открытыми Ключами Группы и Ретрансляторами, отпечатки Ключей Координатора;
// черновик и применение — отказ по праву без записи журнала (ROLE-37, NET-05, NET-13; spec.md US3,
// сценарий 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyFingerprint } from "@aristotel/protocol";
import {
  callAs,
  countRows,
  groupA,
  insertCoordinatorKey,
  registryDocument,
  RELAY_X,
  signDocument,
  startTestService,
  testCoordinatorKey,
} from "../../support/harness.ts";

test("19.15: Наблюдатель читает Реестр и ключи, менять не может", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const k1 = testCoordinatorKey(1);
  insertCoordinatorKey(svc.db, a.c1, k1.publicKey);
  const doc = signDocument(registryDocument(svc.db, { coordinatorKeys: [k1.publicKey] }), k1);
  assert.equal((await callAs(svc, a.c1, "POST", "/api/registry/versions", doc)).statusCode, 201);

  const groupKey = (await callAs(svc, a.n1, "GET", "/api/group-key")).json();
  const state = (await callAs(svc, a.n1, "GET", "/api/registry")).json();
  assert.equal(state.current.number, 1);
  assert.equal(state.current.body.coordinatingGroup, "A");
  assert.deepEqual(state.current.body.groups, [
    { code: "A", signingKey: groupKey.signingKey, encryptionKey: groupKey.encryptionKey, state: "active", relays: [RELAY_X] },
  ]);
  assert.deepEqual(state.current.coordinatorKeyFingerprints, [keyFingerprint(k1.publicKey)]);
  const keys = (await callAs(svc, a.n1, "GET", "/api/coordinator-keys")).json().items;
  assert.deepEqual(keys.map((k: { keyFingerprint: string; inCurrentRegistry: boolean }) => [k.keyFingerprint, k.inCurrentRegistry]), [
    [keyFingerprint(k1.publicKey), true],
  ]);

  const journal = countRows(svc.db, "journal");
  assert.equal((await callAs(svc, a.n1, "POST", "/api/registry/draft", {})).json().error, "forbidden");
  assert.equal((await callAs(svc, a.n1, "POST", "/api/registry/versions", doc)).json().error, "forbidden");
  assert.equal(countRows(svc.db, "journal"), journal);
});
