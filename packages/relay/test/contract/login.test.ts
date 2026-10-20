// T024 фичи 004 — контракт contracts/prohod-v1.md: вход Опорной станции подписанным вызовом Ключом
// Группы и обмен версиями Реестра (RELAY-08, RELAY-09, RELAY-11, RELAY-17, RELAY-18, RELAY-21,
// RELAY-25; research R3, R4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBytes, ed25519Sign, encodeBytes, relayLoginMessage, serializeSignedDocument, type Relay } from "@aristotel/protocol";
import { testCoordinatorKey } from "../../../../tests/support/harness.ts";
import { importRegistry, makeRegistry, prepareRelay, relayFetch, testGroup, type TestGroup, type TestRelay } from "../../../../tests/support/network.ts";

const K1 = testCoordinatorKey(0x61);
const K2 = testCoordinatorKey(0x62);
const A = testGroup("A", 0x63);
const B = testGroup("B", 0x64);

async function relayWith(t: Parameters<typeof prepareRelay>[0], groups: (relay: Relay) => { group: TestGroup; relays: Relay[]; state?: "active" | "suspended" }[]): Promise<TestRelay> {
  const relay = await prepareRelay(t);
  importRegistry(relay, makeRegistry(1, groups(relay.relay), [K1], K1));
  await relay.start();
  return relay;
}

async function challenge(relay: TestRelay): Promise<string> {
  const res = await relayFetch(relay, "POST", "/relay/v1/vhod/vyzov");
  assert.equal(res.status, 200);
  return String(res.body["challenge"]);
}

function sign(group: TestGroup, relay: TestRelay, ch: string, spki = relay.relay.tlsSpki): string {
  return encodeBytes(ed25519Sign(group.key, relayLoginMessage(group.code, decodeBytes(ch, 32)!, decodeBytes(spki, 32)!)));
}

async function login(relay: TestRelay, group: TestGroup, registryNumber = 1, ch?: string, signature?: string) {
  const c = ch ?? (await challenge(relay));
  return await relayFetch(relay, "POST", "/relay/v1/vhod", { code: group.code, registryNumber, challenge: c, signature: signature ?? sign(group, relay, c) });
}

test("вход: подпись Ключом Группы из Реестра — токен на 15 минут; вызов одноразовый", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }]);
  const c = await challenge(relay);
  const ok = await login(relay, A, 1, c);
  assert.equal(ok.status, 200);
  assert.match(String(ok.body["token"]), /^[A-Za-z0-9+/]{43}$/);
  const ttl = Date.parse(String(ok.body["expiresAt"])) - Date.now();
  assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, String(ttl));
  assert.equal(ok.body["registryNumber"], 1);
  assert.equal(ok.body["versions"], undefined);
  const again = await login(relay, A, 1, c);
  assert.equal(again.status, 403, "вызов потрачен");
});

test("отказы входа — 403 forbidden без подробностей", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }, { group: B, relays: [{ url: "https://relay-y.test", tlsSpki: r.tlsSpki.replace(/^./, "A") }] }]);
  const cases: [string, () => Promise<{ status: number; body: Record<string, unknown> }>][] = [
    ["чужой ключ", async () => {
      const c = await challenge(relay);
      return await login(relay, A, 1, c, sign(B, relay, c));
    }],
    ["Ретранслятора нет в записи Группы", () => login(relay, B)],
    ["подпись для другого Ретранслятора", async () => {
      const c = await challenge(relay);
      return await login(relay, A, 1, c, sign(A, relay, c, "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"));
    }],
    ["неизвестный вызов", () => login(relay, A, 1, encodeBytes(new Uint8Array(32)))],
    ["нет Группы", () => login(relay, testGroup("C", 0x65))],
  ];
  for (const [label, run] of cases) {
    const res = await run();
    assert.equal(res.status, 403, label);
    assert.deepEqual(res.body, { error: "forbidden" }, label);
  }
});

test("Группа не действует — вход запрещён (RELAY-09)", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }, { group: B, relays: [r] }]);
  const v2 = makeRegistry(2, [{ group: A, relays: [relay.relay] }, { group: B, relays: [relay.relay], state: "suspended" }], [K1], K1);
  assert.equal((await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(v2))).status, 200);
  assert.equal((await login(relay, B, 2)).status, 403);
  assert.equal((await login(relay, A, 2)).status, 200);
});

test("у станции номер больше — 409 registry_needed; после PUT версии вход проходит, вызов не тратится (RELAY-17)", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }]);
  const v2 = makeRegistry(2, [{ group: A, relays: [relay.relay] }], [K1], K1, "v2");
  const c = await challenge(relay);
  const needed = await login(relay, A, 2, c);
  assert.equal(needed.status, 409);
  assert.equal(needed.body["error"], "registry_needed");
  assert.equal(needed.body["registryNumber"], 1);
  const put = await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(v2));
  assert.equal(put.status, 200);
  assert.equal((await login(relay, A, 2, c)).status, 200);
  assert.equal(readFileSync(join(relay.dir, "registry", "2.json"), "utf8"), serializeSignedDocument(v2), "версия как есть");
});

test("у Ретранслятора номер больше — versions с недостающими (RELAY-18)", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }]);
  const v2 = makeRegistry(2, [{ group: A, relays: [relay.relay] }], [K1, K2], K1, "v2");
  const v3 = makeRegistry(3, [{ group: A, relays: [relay.relay] }], [K2], K2, "v3");
  for (const v of [v2, v3]) assert.equal((await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(v))).status, 200);
  const res = await login(relay, A, 1);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body["versions"], [serializeSignedDocument(v2), serializeSignedDocument(v3)]);
});

test("PUT версии: пропуск номеров — применена; та же — 200; меньший неизвестный — stale; чужая подпись — signature (NET-09)", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }]);
  const v3 = makeRegistry(3, [{ group: A, relays: [relay.relay] }], [K1], K1, "v3");
  assert.equal((await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(v3))).status, 200);
  assert.equal((await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(v3))).status, 200);
  const stale = await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(makeRegistry(2, [{ group: A, relays: [relay.relay] }], [K1], K1, "old")));
  assert.deepEqual(stale.body, { error: "registry_rejected", reason: "stale" });
  const bad = await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(makeRegistry(4, [{ group: A, relays: [relay.relay] }], [K1], K2, "v4")));
  assert.deepEqual(bad.body, { error: "registry_rejected", reason: "signature" });
  assert.equal(relay.server!.registry.number(), 3);
});

test("развилка: не применяет ни одну, тревога только Группе-хозяину; следующая версия снимает остановку (RELAY-21, RELAY-25)", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }, { group: B, relays: [r] }]);
  const first = makeRegistry(2, [{ group: A, relays: [relay.relay] }, { group: B, relays: [relay.relay] }], [K1], K1, "x");
  const second = makeRegistry(2, [{ group: A, relays: [relay.relay] }, { group: B, relays: [relay.relay] }], [K1], K1, "y");
  assert.equal((await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(first))).status, 200);
  const conflict = await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(second));
  assert.equal(conflict.body["reason"], "conflict");
  const conflicts = JSON.parse(readFileSync(join(relay.dir, "registry", "conflicts.json"), "utf8"));
  assert.equal(conflicts[0].number, 2);
  assert.deepEqual((await login(relay, A, 2)).body["conflict"], { number: 2 });
  assert.equal((await login(relay, B, 2)).body["conflict"], undefined, "чужой Группе тревога не отдаётся");
  // Две действующие Группы — по RELAY-25 остановка не снимается (кворум — фича 019).
  const v3two = makeRegistry(3, [{ group: A, relays: [relay.relay] }, { group: B, relays: [relay.relay] }], [K1], K1, "z");
  assert.equal((await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(v3two))).body["reason"], "halted");
});

test("развилка в Сети из одной Группы снимается следующей версией ключом из последней (RELAY-25)", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }]);
  const one = (n: number, note: string) => serializeSignedDocument(makeRegistry(n, [{ group: A, relays: [relay.relay] }], [K1], K1, note));
  await relayFetch(relay, "PUT", "/relay/v1/reestr", one(2, "x"));
  await relayFetch(relay, "PUT", "/relay/v1/reestr", one(2, "y"));
  assert.equal(relay.server!.registry.halted(), true);
  assert.equal((await relayFetch(relay, "PUT", "/relay/v1/reestr", one(3, "z"))).status, 200);
  assert.equal(relay.server!.registry.halted(), false);
  const conflicts = JSON.parse(readFileSync(join(relay.dir, "registry", "conflicts.json"), "utf8"));
  assert.equal(conflicts[0].resolvedBy, 3, "запись о развилке остаётся");
  assert.equal((await login(relay, A, 3)).body["conflict"], undefined);
});

test("другая версия 1, подписанная ключом из неё самой, — не развилка: доверие только ключам установленной версии (NET-09, RELAY-11)", async (t) => {
  const relay = await relayWith(t, (r) => [{ group: A, relays: [r] }]);
  // Посторонний собрал свою версию 1 со своим ключом в списке Ключей Координатора и подписал ею.
  const forged = makeRegistry(1, [{ group: A, relays: [relay.relay] }], [K2], K2, "forged");
  const res = await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(forged));
  assert.deepEqual(res.body, { error: "registry_rejected", reason: "signature" });
  assert.equal(relay.server!.registry.halted(), false);
  assert.equal(existsSync(join(relay.dir, "registry", "conflicts.json")), false);
  // Другая версия 1, подписанная доверенным ключом, — настоящая развилка.
  const other = makeRegistry(1, [{ group: A, relays: [relay.relay] }], [K1], K1, "other");
  assert.equal((await relayFetch(relay, "PUT", "/relay/v1/reestr", serializeSignedDocument(other))).body["reason"], "conflict");
  assert.equal(relay.server!.registry.halted(), true);
});
