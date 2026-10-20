// T007 — контракт contracts/prohod-v1.md: сообщения входа на Ретранслятор и вызова Прохода по
// векторам, схемы тел и строк управляющего соединения (RELAY-08, STATION-04; research R4, R5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  RelayLoginRequest,
  RelayLoginResponse,
  decodeBytes,
  deriveInvitationKeys,
  ed25519FromSeed,
  ed25519Verify,
  parseControlMessage,
  passageMessage,
  publicKeyText,
  relayLoginMessage,
} from "../src/index.ts";

const V = JSON.parse(readFileSync(join(import.meta.dirname, "vectors", "prohod-v1.json"), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const manual = (tag: string, ...fields: (string | Uint8Array)[]) =>
  Buffer.concat([Buffer.from(tag), ...fields.flatMap((f) => [Buffer.from([0]), Buffer.from(f)])]).toString("hex");

test("вход на Ретранслятор: Код, вызов, отпечаток TLS Ретранслятора (RELAY-08)", () => {
  const r = V.relayLogin;
  const challenge = decodeBytes(r.challenge, 32)!;
  const spki = decodeBytes(r.relayTlsSpki, 32)!;
  const message = relayLoginMessage(r.code, challenge, spki);
  assert.equal(hex(message), manual("aristotel/vhod-retranslyatora/v1", r.code, challenge, spki));
  assert.equal(hex(message), r.message);
  assert.equal(publicKeyText(ed25519FromSeed(new Uint8Array(32).fill(V.groupKeySeedByte))), V.groupKey);
  assert.ok(ed25519Verify(V.groupKey, message, decodeBytes(r.signature)!));
  assert.ok(!ed25519Verify(V.groupKey, relayLoginMessage(r.code, challenge, new Uint8Array(32)), decodeBytes(r.signature)!), "другой Ретранслятор");
});

test("вызов Прохода: Код и вызов, подпись ключом Прохода Приглашения (STATION-04)", () => {
  const p = V.passage;
  const challenge = decodeBytes(p.challenge, 32)!;
  const message = passageMessage(p.code, challenge);
  assert.equal(hex(message), manual("aristotel/prohod/v1", p.code, challenge));
  assert.equal(hex(message), p.message);
  const passageKey = deriveInvitationKeys(new Uint8Array(32).fill(2)).passageKey;
  assert.ok(ed25519Verify(passageKey, message, decodeBytes(p.signatureByPassageKey)!));
});

test("схемы входа: лишнее поле — отказ", () => {
  const body = { code: "A", registryNumber: 3, challenge: "x", signature: "y" };
  assert.ok(Value.Check(RelayLoginRequest, body));
  assert.ok(!Value.Check(RelayLoginRequest, { ...body, extra: 1 }));
  assert.ok(Value.Check(RelayLoginResponse, { token: "t", expiresAt: "e", registryNumber: 3, conflict: { number: 3 } }));
  assert.ok(!Value.Check(RelayLoginResponse, { token: "t", expiresAt: "e", registryNumber: 3, other: true }));
});

test("строки управляющего соединения: перечень, вызов, ping, pong; иное — undefined", () => {
  const key = V.groupKey;
  assert.deepEqual(parseControlMessage(`{"type":"call","callId":"abc"}`), { type: "call", callId: "abc" });
  assert.ok(parseControlMessage(JSON.stringify({ type: "passage-list", keys: [{ key, kind: "station", state: "active" }, { key, kind: "invitation", expiresAt: "t" }] })));
  assert.ok(parseControlMessage(`{"type":"ping"}`));
  assert.equal(parseControlMessage(`{"type":"call"}`), undefined);
  assert.equal(parseControlMessage(JSON.stringify({ type: "passage-list", keys: [{ key, kind: "station", state: "lost" }] })), undefined);
  assert.equal(parseControlMessage("не JSON"), undefined);
  assert.equal(parseControlMessage(`{"type":"ping","x":1}`), undefined);
});
