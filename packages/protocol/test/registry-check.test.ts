// T009 — общие правила применения версии Реестра для станции и Ретранслятора: номер, подпись ключом
// из последней известной версии (NET-09), развилка (NET-12), снятие остановки (NET-52, RELAY-25).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REGISTRY_FORMAT,
  addSignature,
  bodySha256,
  checkSuccessor,
  ed25519FromSeed,
  ed25519Sign,
  parseRegistryBody,
  publicKeyText,
  signerAmong,
  type KnownVersion,
  type SignedDocument,
} from "../src/index.ts";

const k1 = ed25519FromSeed(new Uint8Array(32).fill(0x21));
const k2 = ed25519FromSeed(new Uint8Array(32).fill(0x22));
const K1 = publicKeyText(k1);
const K2 = publicKeyText(k2);
const GROUP = publicKeyText(ed25519FromSeed(new Uint8Array(32).fill(0x23)));

function version(number: number, keys: string[], signer: typeof k1, note = "x", groups = 1): { doc: SignedDocument; known: KnownVersion } {
  const list = Array.from({ length: groups }, (_, i) => ({
    code: i === 0 ? "A" : `B${i}`,
    signingKey: GROUP,
    encryptionKey: "age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj",
    state: "active",
    relays: [{ url: `https://relay-${note}.test`, tlsSpki: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk" }],
  }));
  const body = JSON.stringify({ number, issuedAt: "2026-10-18T10:00:00.000Z", coordinatingGroup: "A", coordinatorKeys: keys, groups: list });
  const doc = addSignature({ format: REGISTRY_FORMAT, body, signatures: [] }, publicKeyText(signer), (m) => ed25519Sign(signer, m));
  return { doc, known: { number, bodySha256: bodySha256(body), body: parseRegistryBody(body) } };
}

const firstSigner = (doc: SignedDocument, body: { coordinatorKeys: string[] }) => signerAmong(doc, body.coordinatorKeys);
const check = (ctx: Partial<Parameters<typeof checkSuccessor>[0]>, v: ReturnType<typeof version>) =>
  checkSuccessor({ halted: false, firstSigner, ...ctx }, v.doc, v.known.body, v.known.bodySha256);

test("версия 1 — подписью ключом из неё же; не 1 без Реестра — not-first", () => {
  const v1 = version(1, [K1], k1);
  assert.deepEqual(check({}, v1), { kind: "apply", signer: K1, resolvesConflict: false });
  assert.equal(check({}, version(1, [K1], k2)).kind, "signature");
  assert.equal(check({}, version(2, [K1], k1)).kind, "not-first");
});

test("следующая — ключом из последней версии; пропуск номеров допускается (NET-09)", () => {
  const v1 = version(1, [K1], k1);
  assert.equal(check({ last: v1.known }, version(2, [K2], k1)).kind, "apply");
  assert.equal(check({ last: v1.known }, version(5, [K1], k1)).kind, "apply");
  assert.equal(check({ last: v1.known }, version(2, [K2], k2)).kind, "signature", "ключ не из последней версии");
});

test("номер не больше известного — stale; та же версия — same", () => {
  const v1 = version(1, [K1], k1);
  const v3 = version(3, [K1], k1);
  assert.equal(check({ last: v3.known }, version(2, [K1], k1)).kind, "stale");
  assert.equal(check({ last: v3.known, sameNumber: v3.known, before: v1.known }, v3).kind, "same");
});

test("другая версия с известным номером, подпись ключом из предыдущей — развилка (NET-12)", () => {
  const v1 = version(1, [K1], k1);
  const v2 = version(2, [K1], k1, "a");
  const other = version(2, [K1], k1, "b");
  assert.deepEqual(check({ last: v2.known, sameNumber: v2.known, before: v1.known }, other), { kind: "conflict", signer: K1 });
  assert.equal(check({ last: v2.known, sameNumber: v2.known, before: v1.known }, version(2, [K1], k2, "c")).kind, "signature");
});

test("остановку снимает следующая версия ключом из последней при одной Группе (NET-52, RELAY-25)", () => {
  const v2 = version(2, [K1], k1);
  assert.deepEqual(check({ last: v2.known, halted: true }, version(3, [K1], k1)), { kind: "apply", signer: K1, resolvesConflict: true });
  assert.equal(check({ last: v2.known, halted: true }, version(3, [K1], k2)).kind, "halted");
  const two = version(2, [K1], k1, "x", 2);
  assert.equal(check({ last: two.known, halted: true }, version(3, [K1], k1)).kind, "halted", "две действующие Группы — кворум, фича 019");
});
