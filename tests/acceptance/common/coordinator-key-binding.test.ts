// T028 фичи 003 — привязка Ключа Координатора к Старшему, часть US2: У1 и Н1 не регистрируют ключи и
// у Старшего не больше одного ключа; ключ всегда за автором запроса (NET-13, FR-016; spec.md US2,
// сценарии 5, 6). Отказ им в черновике — T034 и T040 (US3), часть US4 — T050.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinatorKeyProofMessage, parseRegistryBody } from "@aristotel/protocol";
import {
  callAs,
  groupA,
  registryDocument,
  RELAY_X,
  signDocument,
  startTestService,
  testCoordinatorKey,
  type TestCoordinatorKey,
  type TestService,
} from "../../support/harness.ts";

function register(svc: TestService, memberId: string, key: TestCoordinatorKey) {
  const proof = Buffer.from(key.sign(coordinatorKeyProofMessage(svc.install.installId, memberId))).toString("base64").replace(/=+$/, "");
  return callAs(svc, memberId, "POST", "/api/coordinator-keys", { publicKey: key.publicKey, proof });
}

test("US2, сценарии 5, 6: регистрирует только Старший за себя, не больше одного ключа", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  for (const [who, seed] of [[a.u1, 11], [a.n1, 12]] as const) {
    assert.equal((await register(svc, who, testCoordinatorKey(seed))).json().error, "forbidden");
  }
  assert.equal((await register(svc, a.c1, testCoordinatorKey(1))).statusCode, 201);
  assert.equal((await register(svc, a.c1, testCoordinatorKey(2))).json().error, "coordinator_key_exists");

  // Ключ, который С1 «вносит за С2», записывается за самим С1 — а у него ключ уже есть.
  const forC2 = testCoordinatorKey(3);
  const proofForC2 = Buffer.from(forC2.sign(coordinatorKeyProofMessage(svc.install.installId, a.c2 as string))).toString("base64").replace(/=+$/, "");
  const res = await callAs(svc, a.c1, "POST", "/api/coordinator-keys", { publicKey: forC2.publicKey, proof: proofForC2 });
  assert.equal(res.statusCode, 422, "доказательство над memberId С2 не подходит автору С1");
  const owners = svc.db.prepare("SELECT memberId FROM coordinator_key WHERE state = 'registered'").all().map((r) => r["memberId"]);
  assert.deepEqual(owners, [a.c1]);
});

// T050 фичи 003 — часть US4: ключ Старшего, снятого с роли, действует, пока последняя версия его
// содержит; следующий черновик его не берёт; версия с ним — coordinator_key_unbound (FR-016, NET-15;
// spec.md US2, сценарий 7).
test("US2, сценарий 7: ключ снятого Старшего — до следующей версии", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const k1 = testCoordinatorKey(1);
  const k2 = testCoordinatorKey(2);
  assert.equal((await register(svc, a.c1, k1)).statusCode, 201);
  assert.equal((await register(svc, a.c2 as string, k2)).statusCode, 201);
  const draft = async () => (await callAs(svc, a.c1, "POST", "/api/registry/draft", { code: "A", addRelays: [RELAY_X] })).json();
  const apply = (doc: unknown) => callAs(svc, a.c1, "POST", "/api/registry/versions", doc);
  assert.equal((await apply(signDocument(await draft(), k1))).statusCode, 201);

  // С2 снят с роли Старшего: его ключ всё ещё в версии 1 — версия 2, подписанная им, применяется.
  const c2 = (await callAs(svc, a.c1, "GET", `/api/members/${a.c2}`)).json();
  assert.equal((await callAs(svc, a.c1, "PATCH", `/api/members/${a.c2}`, { expectedVersion: c2.version, role: "participant" })).statusCode, 200);
  const v2 = await draft();
  assert.deepEqual(parseRegistryBody(v2.body).coordinatorKeys, [k1.publicKey], "черновик ключа С2 уже не берёт");
  const signedByC2 = await apply(signDocument(v2, k2));
  assert.equal(signedByC2.statusCode, 201, signedByC2.body);

  // Версия, где ключ С2 остался, — отказ: он не за действующим Старшим.
  const stale = signDocument(registryDocument(svc.db, { number: 3, coordinatorKeys: [k1.publicKey, k2.publicKey] }), k1);
  const res = await apply(stale);
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().reason, "coordinator_key_unbound");
  // А подпись ключом С2 после версии 2 недействительна (NET-15).
  const v3 = await draft();
  assert.equal((await apply(signDocument(v3, k2))).json().reason, "signature");
});
