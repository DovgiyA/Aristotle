// T048 фичи 003 — сценарий 23, шаг 23.10: другая версия 3 останавливает применение (NET-12); версия,
// которая не снимает остановку по NET-52, — registry_halted; версия 4 с ключом из версии 3 снимает её,
// запись о развилке в журнале остаётся (NET-12, NET-52, NET-11; spec.md US4, сценарии 5, 6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, groupA, insertCoordinatorKey, registryDocument, RELAY_X, RELAY_Y, signDocument, startTestService, testCoordinatorKey } from "../../support/harness.ts";

test("23.10: развилка версии 3 и её снятие версией 4", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const k1 = testCoordinatorKey(1);
  const k2 = testCoordinatorKey(2);
  insertCoordinatorKey(svc.db, a.c1, k1.publicKey);
  insertCoordinatorKey(svc.db, a.c2 as string, k2.publicKey);
  const keys = [k1.publicKey, k2.publicKey];
  const version = (number: number, signer: typeof k1, relays = [RELAY_X]) =>
    signDocument(registryDocument(svc.db, { number, coordinatorKeys: keys, relays }), signer);
  const apply = (doc: unknown) => callAs(svc, a.c1, "POST", "/api/registry/versions", doc);
  for (const n of [1, 2, 3]) assert.equal((await apply(version(n, k1))).statusCode, 201);

  const fork = await apply(version(3, k2, [RELAY_Y]));
  assert.equal(fork.statusCode, 409);
  assert.equal(fork.json().error, "registry_conflict");
  let state = (await callAs(svc, a.n1, "GET", "/api/registry")).json();
  assert.equal(state.halted, true);
  assert.equal(state.current.number, 3, "станция действует по известной версии (NET-11)");

  // Подпись ключом не из версии 3 остановку не снимает.
  const stranger = testCoordinatorKey(9);
  const notLifting = await apply(signDocument(registryDocument(svc.db, { number: 4, coordinatorKeys: keys }), stranger));
  assert.equal(notLifting.statusCode, 409);
  assert.equal(notLifting.json().error, "registry_halted");

  const lifted = await apply(version(4, k2));
  assert.equal(lifted.statusCode, 201, lifted.body);
  state = (await callAs(svc, a.n1, "GET", "/api/registry")).json();
  assert.equal(state.halted, false);
  assert.equal(state.current.number, 4);
  assert.deepEqual(state.conflicts.map((c: { number: number; resolvedBy: number }) => [c.number, c.resolvedBy]), [[3, 4]]);
  const applied = svc.db.prepare("SELECT details FROM journal WHERE action = 'registry.apply' ORDER BY seq").all().at(-1);
  assert.deepEqual(JSON.parse(String(applied?.["details"])).resolved, [3]);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'registry.conflict'").get()?.["n"], 1);
  assert.equal((await apply(version(5, k1))).statusCode, 201, "дальше версии применяются как обычно");
});
