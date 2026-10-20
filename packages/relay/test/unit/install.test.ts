// T026 фичи 004 — установка Ретранслятора — третьей роли программы, отдельной от Опорной станции, — и
// первая версия Реестра (RELAY-02, RELAY-22, RELAY-19, RELAY-16; research R3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeSignedDocument } from "@aristotel/protocol";
import { readInstall } from "@aristotel/core";
import { RelayRegistry, RelayRegistryError } from "../../src/index.ts";
import { testCoordinatorKey } from "../../../../tests/support/harness.ts";
import { makeRegistry, prepareRelay, testGroup } from "../../../../tests/support/network.ts";

const K1 = testCoordinatorKey(0x51);
const A = testGroup("A", 0x52);

test("init --role relay: install.json с Кодом, адресом и URL; TLS-ключ и сертификат", async (t) => {
  const relay = await prepareRelay(t);
  const install = readInstall(relay.dir);
  assert.equal(install.role, "relay");
  assert.equal(install.relay?.group, "A");
  assert.match(install.relay?.url ?? "", /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(existsSync(join(relay.dir, "tls-key.pem")));
  assert.ok(existsSync(join(relay.dir, "tls-cert.pem")));
  assert.match(relay.relay.tlsSpki, /^[A-Za-z0-9+/]{43}$/);
});

function importInto(relay: Awaited<ReturnType<typeof prepareRelay>>, doc: ReturnType<typeof makeRegistry>, group = "A"): number {
  return new RelayRegistry(relay.dir, group, relay.relay.tlsSpki).importFirst(serializeSignedDocument(doc));
}

test("первая версия: подпись ключом из неё же, своя Группа действует, этот Ретранслятор в её записи — принята", async (t) => {
  const relay = await prepareRelay(t);
  assert.equal(importInto(relay, makeRegistry(1, [{ group: A, relays: [relay.relay] }], [K1], K1)), 1);
  assert.ok(existsSync(join(relay.dir, "registry", "1.json")));
  assert.equal(new RelayRegistry(relay.dir, "A", relay.relay.tlsSpki).number(), 1, "после перезапуска версия на месте");
});

test("первая версия: без этого Ретранслятора, с чужим Кодом, неверной подписью — отказ с причиной", async (t) => {
  const relay = await prepareRelay(t);
  const other = await prepareRelay(t);
  const reason = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof RelayRegistryError);
      return error.reason;
    }
    return "accepted";
  };
  assert.equal(reason(() => importInto(relay, makeRegistry(1, [{ group: A, relays: [other.relay] }], [K1], K1))), "not_listed");
  assert.equal(reason(() => importInto(relay, makeRegistry(1, [{ group: A, relays: [relay.relay] }], [K1], K1), "B")), "not_member");
  assert.equal(reason(() => importInto(relay, makeRegistry(1, [{ group: A, relays: [relay.relay] }], [K1], testCoordinatorKey(0x53)))), "signature");
  assert.equal(reason(() => new RelayRegistry(relay.dir, "A", relay.relay.tlsSpki).importFirst("{}")), "format");
  assert.equal(existsSync(join(relay.dir, "registry", "1.json")), false);
});

test("повторный импорт другой версии 1 — отказ: Реестр уже есть", async (t) => {
  const relay = await prepareRelay(t);
  importInto(relay, makeRegistry(1, [{ group: A, relays: [relay.relay] }], [K1], K1));
  const before = readFileSync(join(relay.dir, "registry", "1.json"), "utf8");
  assert.throws(() => importInto(relay, makeRegistry(1, [{ group: A, relays: [relay.relay] }], [K1], K1, "other")), (e: unknown) => (e as RelayRegistryError).reason === "already");
  assert.equal(readFileSync(join(relay.dir, "registry", "1.json"), "utf8"), before);
});
