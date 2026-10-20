// T035 фичи 003 — POST /api/registry/versions по contracts/http-api.md, версия 1: применение, повтор,
// отказы с reason и журналом, развилка по номеру 1 только для ключа действующего Старшего, чтение
// Реестра и версии как есть, права, Ключ Группы недоступен (FR-006, FR-007, FR-010, FR-011, NET-09,
// NET-12, NET-18, NET-53, ROLE-01; research R9, R10). Следующие версии — T052.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { REGISTRY_FORMAT, bodySha256, keyFingerprint, serializeSignedDocument, type SignedDocument } from "@aristotel/protocol";
import { groupKeyPath } from "@aristotel/core";
import {
  callAs,
  groupA,
  insertCoordinatorKey,
  insertRegistryVersion,
  registryDocument,
  restartTestService,
  RELAY_Y,
  signDocument,
  startTestService,
  testCoordinatorKey,
  type TestService,
} from "../../../../tests/support/harness.ts";

const k1 = testCoordinatorKey(1);

async function launched(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  insertCoordinatorKey(svc.db, a.c1, k1.publicKey);
  return { svc, a };
}

const apply = (svc: TestService, memberId: string, doc: SignedDocument | Record<string, unknown>) =>
  callAs(svc, memberId, "POST", "/api/registry/versions", doc);

function rejects(svc: TestService) {
  return svc.db.prepare("SELECT actorId, subjectId, details FROM journal WHERE action = 'registry.reject' ORDER BY seq").all();
}

test("версия 1, подписанная ключом С1: 201, Реестр, журнал; повтор — 200 без журнала", async (t) => {
  const { svc, a } = await launched(t);
  const doc = signDocument(registryDocument(svc.db, { coordinatorKeys: [k1.publicKey] }), k1);
  const res = await apply(svc, a.c1, doc);
  assert.equal(res.statusCode, 201, res.body);
  const current = res.json();
  assert.equal(current.number, 1);
  assert.equal(current.bodySha256, bodySha256(doc.body));
  assert.deepEqual(current.appliedBy, { id: a.c1, label: "С1" });
  assert.deepEqual(current.signedBy, { key: k1.publicKey, keyFingerprint: keyFingerprint(k1.publicKey) });
  assert.deepEqual(current.coordinatorKeyFingerprints, [keyFingerprint(k1.publicKey)]);
  assert.equal(current.body.coordinatingGroup, "A");
  const journal = svc.db.prepare("SELECT actorId, subjectType, subjectId, details FROM journal WHERE action = 'registry.apply'").all();
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.["actorId"], a.c1);
  assert.equal(journal[0]?.["subjectType"], "registry");
  assert.equal(journal[0]?.["subjectId"], "1");
  assert.deepEqual(JSON.parse(String(journal[0]?.["details"])), { number: 1, signedBy: keyFingerprint(k1.publicKey) });

  const again = await apply(svc, a.c1, doc);
  assert.equal(again.statusCode, 200);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action LIKE 'registry.%'").get()?.["n"], 1);

  for (const reader of [a.u1, a.n1]) {
    const state = (await callAs(svc, reader, "GET", "/api/registry")).json();
    assert.equal(state.current.number, 1);
    assert.equal(state.halted, false);
    assert.deepEqual(state.conflicts, []);
  }
  const raw = await callAs(svc, a.n1, "GET", "/api/registry/versions/1");
  assert.equal(raw.statusCode, 200);
  assert.match(String(raw.headers["content-type"]), /application\/json/);
  assert.equal(raw.body, serializeSignedDocument(doc));
  assert.equal((await callAs(svc, a.n1, "GET", "/api/registry/versions/2")).statusCode, 404);
});

test("без Реестра — current null", async (t) => {
  const { svc, a } = await launched(t);
  const { current, halted, conflicts } = (await callAs(svc, a.n1, "GET", "/api/registry")).json();
  assert.deepEqual({ current, halted, conflicts }, { current: null, halted: false, conflicts: [] });
});

test("отказы версии 1 — 422 с reason и журналом registry.reject", async (t) => {
  const { svc, a } = await launched(t);
  const k2 = testCoordinatorKey(2);
  const base = { coordinatorKeys: [k1.publicKey] };
  const cases: [string, SignedDocument | Record<string, unknown>][] = [
    ["unsigned", registryDocument(svc.db, base)],
    ["signature", signDocument(registryDocument(svc.db, base), k2)],
    // Ключ из версии, но не зарегистрированный за действующим Старшим.
    ["signature", signDocument(registryDocument(svc.db, { coordinatorKeys: [k2.publicKey] }), k2)],
    ["format", { format: REGISTRY_FORMAT, body: "{}", signatures: [] }],
    ["format", { format: "aristotel/slovar/v1", body: "{}", signatures: [] }],
    // Реестра нет — только версия с номером 1 (NET-16; contracts/http-api.md, T064).
    ["format", signDocument(registryDocument(svc.db, { ...base, number: 2 }), k1)],
    ["code_format", signDocument(registryDocument(svc.db, { ...base, code: "a1" }), k1)],
    ["group_key_mismatch", signDocument(registryDocument(svc.db, { ...base, change: (_, g) => (g["signingKey"] = k2.publicKey) }), k1)],
    ["no_relay", signDocument(registryDocument(svc.db, { ...base, relays: [] }), k1)],
    [
      "foreign_groups",
      signDocument(
        registryDocument(svc.db, {
          ...base,
          change: (b, g) => (b["groups"] = [g, { ...g, code: "B", signingKey: k2.publicKey }]),
        }),
        k1,
      ),
    ],
    ["own_state", signDocument(registryDocument(svc.db, { ...base, change: (_, g) => ((g["state"] = "suspended"), (g["relays"] = [])) }), k1)],
    [
      "not_coordinating",
      signDocument(
        registryDocument(svc.db, {
          ...base,
          change: (b, g) => ((b["groups"] = [g, { ...g, code: "B", signingKey: k2.publicKey }]), (b["coordinatingGroup"] = "B")),
        }),
        k1,
      ),
    ],
    ["coordinator_key_unbound", signDocument(registryDocument(svc.db, { coordinatorKeys: [k1.publicKey, k2.publicKey] }), k1)],
  ];
  for (const [reason, doc] of cases) {
    const res = await apply(svc, a.c1, doc);
    assert.equal(res.statusCode, 422, `${reason}: ${res.body}`);
    assert.equal(res.json().error, "registry_rejected", reason);
    assert.equal(res.json().reason, reason, `${reason}: ${res.body}`);
  }
  const journal = rejects(svc);
  assert.equal(journal.length, cases.length);
  assert.ok(journal.every((r) => r["actorId"] === a.c1));
  assert.deepEqual(
    journal.map((r) => JSON.parse(String(r["details"])).reason),
    cases.map(([reason]) => reason),
  );
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM registry_version").get()?.["n"], 0);
  // По праву — 403 без журнала.
  const good = signDocument(registryDocument(svc.db, base), k1);
  for (const who of [a.u1, a.n1]) assert.equal((await apply(svc, who, good)).json().error, "forbidden");
  assert.equal(rejects(svc).length, cases.length);
});

test("другая версия 1: ключ не за действующим Старшим — отказ без остановки; ключ С2 — развилка (NET-12, NET-18)", async (t) => {
  const { svc, a } = await launched(t);
  assert.equal((await apply(svc, a.c1, signDocument(registryDocument(svc.db, { coordinatorKeys: [k1.publicKey] }), k1))).statusCode, 201);

  const stranger = testCoordinatorKey(9);
  const foreign = signDocument(registryDocument(svc.db, { coordinatorKeys: [stranger.publicKey] }), stranger);
  const refused = await apply(svc, a.c1, foreign);
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().reason, "signature");
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM registry_conflict").get()?.["n"], 0);
  assert.equal((await callAs(svc, a.c1, "GET", "/api/registry")).json().halted, false);

  const k2 = testCoordinatorKey(2);
  insertCoordinatorKey(svc.db, a.c2 as string, k2.publicKey);
  const other = signDocument(registryDocument(svc.db, { coordinatorKeys: [k2.publicKey], relays: [RELAY_Y] }), k2);
  const conflict = await apply(svc, a.c2 as string, other);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, "registry_conflict");
  const state = (await callAs(svc, a.n1, "GET", "/api/registry")).json();
  assert.equal(state.halted, true);
  assert.equal(state.current.number, 1);
  assert.deepEqual(state.conflicts.map((c: { number: number; resolvedBy: unknown }) => [c.number, c.resolvedBy]), [[1, null]]);
  const journal = svc.db.prepare("SELECT details FROM journal WHERE action = 'registry.conflict'").all();
  assert.equal(journal.length, 1);
  assert.equal(JSON.parse(String(journal[0]?.["details"])).number, 1);
});

test("Ключ Группы недоступен — черновик и применение 409, чтение Реестра — 200 (NET-53)", async (t) => {
  let { svc, a } = await launched(t);
  insertRegistryVersion(svc.db, signDocument(registryDocument(svc.db, { coordinatorKeys: [k1.publicKey] }), k1), a.c1);
  rmSync(groupKeyPath(svc.dir));
  svc = await restartTestService(t, svc);
  assert.equal((await callAs(svc, a.c1, "POST", "/api/registry/draft", {})).json().error, "group_key_unavailable");
  const doc = signDocument(registryDocument(svc.db, { number: 2, coordinatorKeys: [k1.publicKey] }), k1);
  assert.equal((await apply(svc, a.c1, doc)).json().error, "group_key_unavailable");
  assert.equal((await callAs(svc, a.n1, "GET", "/api/registry")).statusCode, 200);
});

// T052 фичи 003 — следующие версии: registry_stale, registry_halted, снятие остановки по NET-52 с
// resolvedBy и журналом (research R9, R10).
test("следующие версии: stale, halted, снятие остановки", async (t) => {
  const { svc, a } = await launched(t);
  const k2 = testCoordinatorKey(2);
  insertCoordinatorKey(svc.db, a.c2 as string, k2.publicKey);
  const keys = [k1.publicKey, k2.publicKey];
  const version = (number: number, signer = k1, relays?: (typeof RELAY_Y)[]) =>
    signDocument(registryDocument(svc.db, { number, coordinatorKeys: keys, ...(relays === undefined ? {} : { relays }) }), signer);
  for (const n of [1, 3]) assert.equal((await apply(svc, a.c1, version(n))).statusCode, 201);

  const stale = await apply(svc, a.c1, version(2));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, "registry_stale");
  assert.equal(stale.json().reason, "stale");

  assert.equal((await apply(svc, a.c1, version(3, k2, [RELAY_Y]))).json().error, "registry_conflict");
  const halted = await apply(svc, a.c1, version(4, testCoordinatorKey(9)));
  assert.equal(halted.statusCode, 409);
  assert.equal(halted.json().error, "registry_halted");
  assert.equal(halted.json().reason, "halted");
  assert.deepEqual(JSON.parse(String(rejects(svc).at(-1)?.["details"])), { reason: "halted", number: 4 });

  const lifted = await apply(svc, a.c1, version(4));
  assert.equal(lifted.statusCode, 201);
  const state = (await callAs(svc, a.n1, "GET", "/api/registry")).json();
  assert.equal(state.halted, false);
  assert.deepEqual(state.conflicts[0].resolvedBy, 4);
});
