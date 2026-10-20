// T049 фичи 003 — SC-003: каждая версия, нарушающая условие FR-006 … FR-009, FR-012, FR-014, FR-016,
// отклоняется, действующая версия и её bodySha256 не меняются, отказ — в журнале (NET-06, NET-09,
// NET-12, NET-15, NET-17, NET-51).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callAs,
  groupA,
  insertCoordinatorKey,
  registryDocument,
  RELAY_X,
  RELAY_Y,
  signDocument,
  startTestService,
  testCoordinatorKey,
  type RegistryBodyOptions,
} from "../../support/harness.ts";

test("SC-003: отказы следующей версии и развилка — Реестр не меняется, отказ в журнале", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const k1 = testCoordinatorKey(1);
  const k2 = testCoordinatorKey(2);
  const old = testCoordinatorKey(3);
  insertCoordinatorKey(svc.db, a.c1, old.publicKey);
  svc.db.prepare("UPDATE coordinator_key SET state = 'withdrawn', withdrawnAt = 't' WHERE publicKey = ?").run(old.publicKey);
  insertCoordinatorKey(svc.db, a.c1, k1.publicKey);
  const k4 = testCoordinatorKey(4);
  const doc = (options: Partial<RegistryBodyOptions>, signer = k1) =>
    signDocument(registryDocument(svc.db, { coordinatorKeys: [k1.publicKey], ...options }), signer);
  const apply = (body: unknown) => callAs(svc, a.c1, "POST", "/api/registry/versions", body);
  assert.equal((await apply(doc({ number: 1 }))).statusCode, 201);
  assert.equal((await apply(doc({ number: 3, relays: [RELAY_Y] }))).statusCode, 201);
  insertCoordinatorKey(svc.db, a.c2 as string, k4.publicKey);

  const cases: [string, unknown, number, string][] = [
    ["номер меньше известного", doc({ number: 2 }), 409, "registry_stale"],
    ["подпись ключом не из версии 3", doc({ number: 4 }, k2), 422, "signature"],
    // Ключ С2 зарегистрирован за действующим Старшим, но его нет в действующей версии 3 (NET-09).
    ["подпись новым ключом Старшего, которого нет в версии 3", doc({ number: 4, coordinatorKeys: [k1.publicKey, k4.publicKey] }, k4), 422, "signature"],
    ["чужие Ключи Группы своей записи", doc({ number: 4, change: (_, g) => (g["signingKey"] = k2.publicKey) }), 422, "group_key_mismatch"],
    ["ни одного Ретранслятора", doc({ number: 4, relays: [] }), 422, "no_relay"],
    ["смена Кода", doc({ number: 4, code: "B" }), 422, "code_changed"],
    ["Код не по NET-51", doc({ number: 4, code: "a1" }), 422, "code_format"],
    ["записи других Групп", doc({ number: 4, change: (b, g) => (b["groups"] = [g, { ...g, code: "B", signingKey: k2.publicKey }]) }), 422, "foreign_groups"],
    ["своя запись приостановлена", doc({ number: 4, change: (_, g) => ((g["state"] = "suspended"), (g["relays"] = [])) }), 422, "own_state"],
    ["своя запись исключена", doc({ number: 4, change: (_, g) => ((g["state"] = "excluded"), (g["relays"] = [])) }), 422, "own_state"],
    [
      "Координирующая — не своя",
      doc({ number: 4, change: (b, g) => ((b["groups"] = [g, { ...g, code: "B", signingKey: k2.publicKey }]), (b["coordinatingGroup"] = "B")) }),
      422,
      "not_coordinating",
    ],
    ["Ключ Координатора не за действующим Старшим", doc({ number: 4, coordinatorKeys: [k1.publicKey, k2.publicKey] }), 422, "coordinator_key_unbound"],
    ["два ключа одного Старшего (прежний снят)", doc({ number: 4, coordinatorKeys: [k1.publicKey, old.publicKey] }), 422, "coordinator_key_unbound"],
    ["вторая версия с тем же номером", doc({ number: 3, relays: [RELAY_X] }), 409, "registry_conflict"],
    ["станция остановлена", doc({ number: 4, code: "B" }, k2), 409, "registry_halted"],
  ];
  const current = (await callAs(svc, a.n1, "GET", "/api/registry")).json().current;
  for (const [name, body, status, code] of cases) {
    const journalBefore = Number(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action IN ('registry.reject', 'registry.conflict')").get()?.["n"]);
    const res = await apply(body);
    assert.equal(res.statusCode, status, `${name}: ${res.body}`);
    // 422 — registry_rejected с причиной в reason; 409 — свой код ошибки.
    assert.equal(status === 422 ? res.json().reason : res.json().error, code, name);
    const after = (await callAs(svc, a.n1, "GET", "/api/registry")).json().current;
    assert.equal(after.number, current.number, name);
    assert.equal(after.bodySha256, current.bodySha256, name);
    const journalAfter = Number(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action IN ('registry.reject', 'registry.conflict')").get()?.["n"]);
    assert.equal(journalAfter, journalBefore + 1, `${name}: отказ в журнале`);
  }
});
