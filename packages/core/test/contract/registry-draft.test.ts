// T034 фичи 003 — POST /api/registry/draft по contracts/http-api.md: черновик версии 1 — номер,
// своя запись по текущему Ключу Группы, Ретрансляторы, Координирующая — своя, Ключи Координатора
// действующих Старших; отказы; черновик не хранится и журнал не пишет (FR-006, NET-16, NET-17,
// NET-51, ROLE-01; research R8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY_FORMAT, parseRegistryBody } from "@aristotel/protocol";
import { callAs, countRows, groupA, insertCoordinatorKey, RELAY_X, RELAY_Y, signDocument, startTestService, testCoordinatorKey } from "../../../../tests/support/harness.ts";

test("черновик версии 1: неподписанный документ по правилам research R8", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const k1 = testCoordinatorKey(1);
  const k2 = testCoordinatorKey(2);
  insertCoordinatorKey(svc.db, a.c1, k1.publicKey);
  insertCoordinatorKey(svc.db, a.c2 as string, k2.publicKey);
  const journalBefore = countRows(svc.db, "journal");

  const res = await callAs(svc, a.c1, "POST", "/api/registry/draft", { code: "A", addRelays: [RELAY_X, RELAY_Y] });
  assert.equal(res.statusCode, 200, res.body);
  const doc = res.json();
  assert.equal(doc.format, REGISTRY_FORMAT);
  assert.deepEqual(doc.signatures, []);
  const body = parseRegistryBody(doc.body);
  const key = (await callAs(svc, a.c1, "GET", "/api/group-key")).json();
  assert.equal(body.number, 1);
  assert.equal(body.coordinatingGroup, "A");
  assert.deepEqual(body.coordinatorKeys, [k1.publicKey, k2.publicKey]);
  assert.deepEqual(body.groups, [
    { code: "A", signingKey: key.signingKey, encryptionKey: key.encryptionKey, state: "active", relays: [RELAY_X, RELAY_Y] },
  ]);
  assert.equal(countRows(svc.db, "journal"), journalBefore);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM registry_version").get()?.["n"], 0);
});

test("черновик: отказы и права", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const draft = (memberId: string, payload: unknown) => callAs(svc, memberId, "POST", "/api/registry/draft", payload);

  assert.equal((await draft(a.c1, { code: "A", addRelays: [RELAY_X] })).json().error, "coordinator_key_missing");
  insertCoordinatorKey(svc.db, a.c1, testCoordinatorKey(1).publicKey);
  const noRelay = await draft(a.c1, { code: "A" });
  assert.equal(noRelay.statusCode, 422);
  assert.equal(noRelay.json().reason, "no_relay");
  const badCode = await draft(a.c1, { code: "a1", addRelays: [RELAY_X] });
  assert.equal(badCode.statusCode, 422);
  assert.equal(badCode.json().reason, "code_format");
  const noCode = await draft(a.c1, { addRelays: [RELAY_X] });
  assert.equal(noCode.json().reason, "code_format");
  const badUrl = await draft(a.c1, { code: "A", addRelays: [{ url: "http://relay-x.test", tlsSpki: RELAY_X.tlsSpki }] });
  assert.equal(badUrl.json().reason, "format");
  for (const who of [a.u1, a.n1]) assert.equal((await draft(who, { code: "A", addRelays: [RELAY_X] })).json().error, "forbidden");
  // Ключ снятого с роли Старшего в черновик не попадает.
  insertCoordinatorKey(svc.db, a.c2 as string, testCoordinatorKey(2).publicKey);
  svc.db.prepare("UPDATE member SET role = 'participant', version = version + 1 WHERE id = ?").run(a.c2 as string);
  const body = parseRegistryBody((await draft(a.c1, { code: "A", addRelays: [RELAY_X] })).json().body);
  assert.deepEqual(body.coordinatorKeys, [testCoordinatorKey(1).publicKey]);
});

// T052 фичи 003 — черновик следующей версии: номер последний + 1, Код из последней версии,
// Ретрансляторы от последней версии; убрать последний — no_relay; чужой Код — code_changed (research R8).
test("черновик следующей версии", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const k1 = testCoordinatorKey(1);
  insertCoordinatorKey(svc.db, a.c1, k1.publicKey);
  const draft = (payload: unknown) => callAs(svc, a.c1, "POST", "/api/registry/draft", payload);
  const v1 = (await draft({ code: "K2", addRelays: [RELAY_X] })).json();
  assert.equal((await callAs(svc, a.c1, "POST", "/api/registry/versions", signDocument(v1, k1))).statusCode, 201);

  const v2 = parseRegistryBody((await draft({ addRelays: [RELAY_Y] })).json().body);
  assert.equal(v2.number, 2);
  assert.equal(v2.groups[0]?.code, "K2");
  assert.deepEqual(v2.groups[0]?.relays, [RELAY_X, RELAY_Y]);
  // Тот же адрес с новым отпечатком — замена отпечатка (смена ключа Ретранслятора, RELAY-16).
  const replaced = parseRegistryBody((await draft({ addRelays: [{ url: RELAY_X.url, tlsSpki: RELAY_Y.tlsSpki }] })).json().body);
  assert.deepEqual(replaced.groups[0]?.relays, [{ url: RELAY_X.url, tlsSpki: RELAY_Y.tlsSpki }]);
  const removed = parseRegistryBody((await draft({ addRelays: [RELAY_Y], removeRelays: [RELAY_X.url] })).json().body);
  assert.deepEqual(removed.groups[0]?.relays, [RELAY_Y]);
  assert.equal(parseRegistryBody((await draft({ code: "K2" })).json().body).groups[0]?.code, "K2");

  const noRelay = await draft({ removeRelays: [RELAY_X.url] });
  assert.equal(noRelay.statusCode, 422);
  assert.equal(noRelay.json().reason, "no_relay");
  const otherCode = await draft({ code: "B" });
  assert.equal(otherCode.statusCode, 422);
  assert.equal(otherCode.json().reason, "code_changed");
});
