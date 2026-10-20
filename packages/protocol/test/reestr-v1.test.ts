// T004 фичи 003 — контракт документа версии Реестра `aristotel/reestr/v1`: векторы, отпечатки,
// Код Группы, схемы документа и тела (contracts/reestr-v1.md; NET-04, NET-06, NET-41, NET-42, NET-51,
// RELAY-16; research R4, R5, R13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  REGISTRY_FORMAT,
  RegistryFormatError,
  SignedDocumentError,
  addSignature,
  bodySha256,
  decodeKey,
  encodeKey,
  isGroupCode,
  keyFingerprint,
  parseRegistryBody,
  parseSignedDocument,
  serializeSignedDocument,
  spkiFingerprint,
  verifySignature,
  type SignedDocument,
} from "../src/index.ts";

const dir = new URL("./vectors/", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("reestr-v1.json", dir), "utf8")) as Record<string, string | number>;
const pem = (name: string) => readFileSync(new URL(name, dir), "utf8");

function seedKey(byte: number) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, byte)]),
    format: "der",
    type: "pkcs8",
  });
}

function rawPublic(byte: number): Uint8Array {
  const jwk = seedKey(byte).export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url");
}

const body = String(vectors["body"]);
const coordinatorKey = String(vectors["coordinatorKey"]);
const signer = (message: Uint8Array) => sign(null, message, seedKey(1));

function signed(): SignedDocument {
  return addSignature({ format: REGISTRY_FORMAT, body, signatures: [] }, coordinatorKey, signer);
}

test("вектор 1: ключ из семени и его отпечаток (NET-41, NET-42)", () => {
  assert.equal(encodeKey(rawPublic(1)), coordinatorKey);
  assert.equal(keyFingerprint(coordinatorKey), vectors["coordinatorKeyFingerprint"]);
  assert.equal(encodeKey(rawPublic(2)), vectors["groupSigningKey"]);
  assert.equal(keyFingerprint(String(vectors["groupSigningKey"])), vectors["groupKeyFingerprint"]);
  assert.match(keyFingerprint(coordinatorKey), /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
  assert.notEqual(keyFingerprint(coordinatorKey), keyFingerprint(String(vectors["groupSigningKey"])));
  assert.ok(!coordinatorKey.includes("="));
  assert.equal(decodeKey(coordinatorKey)?.length, 32);
  assert.equal(decodeKey(coordinatorKey + "="), undefined);
  assert.equal(decodeKey(coordinatorKey.slice(1)), undefined);
  // Неканоническая запись (лишние биты в последнем знаке) — не ключ.
  assert.equal(decodeKey("x".repeat(43)), undefined);
});

test("вектор 2: хэш тела и детерминированная подпись Ed25519", () => {
  assert.equal(bodySha256(body), vectors["bodySha256"]);
  const doc = signed();
  assert.equal(doc.signatures[0]?.sig, vectors["signature"]);
  assert.ok(verifySignature(doc, coordinatorKey));
  assert.ok(!verifySignature(doc, String(vectors["groupSigningKey"])));
  const reparsed = parseSignedDocument(serializeSignedDocument(doc), REGISTRY_FORMAT);
  assert.deepEqual(reparsed, doc);
  assert.ok(verifySignature(reparsed, coordinatorKey));
});

test("вектор 3: порча одного байта тела — подпись не проверяется", () => {
  const doc = signed();
  const broken = { ...doc, body: body.replace('"number":1', '"number":2') };
  assert.ok(!verifySignature(broken, coordinatorKey));
});

test("вектор 4: отпечаток SPKI; перевыпуск на том же ключе — тот же, другой ключ — другой (RELAY-16)", () => {
  assert.equal(spkiFingerprint(pem("relay-x.pem")), vectors["relayXSpki"]);
  assert.equal(spkiFingerprint(pem("relay-x-reissued.pem")), vectors["relayXSpki"]);
  assert.equal(spkiFingerprint(pem("relay-y.pem")), vectors["relayYSpki"]);
  assert.notEqual(vectors["relayXSpki"], vectors["relayYSpki"]);
  assert.equal(decodeKey(String(vectors["relayXSpki"]))?.length, 32);
});

test("Код Группы по NET-51", () => {
  for (const code of ["A", "K2", "ABCDEFGH", "Z9"]) assert.ok(isGroupCode(code), code);
  for (const code of ["a1", "А", "1A", "ABCDEFGHI", "", "A-1", "A "]) assert.ok(!isGroupCode(code), code);
});

test("тело версии 1 из векторов разбирается", () => {
  const parsed = parseRegistryBody(body);
  assert.equal(parsed.number, 1);
  assert.equal(parsed.coordinatingGroup, "A");
  assert.equal(parsed.groups[0]?.relays[0]?.url, "https://relay-x.test:8443");
});

function signedText(change: (doc: Record<string, unknown>) => void): string {
  const doc = JSON.parse(serializeSignedDocument(signed())) as Record<string, unknown>;
  change(doc);
  return JSON.stringify(doc);
}

test("документ: лишние поля, чужой format, длинное тело, повтор ключа — отказ", () => {
  const rejects = (text: string) => assert.throws(() => parseSignedDocument(text, REGISTRY_FORMAT), SignedDocumentError);
  rejects(signedText((d) => (d["extra"] = 1)));
  rejects(signedText((d) => (d["format"] = "aristotel/slovar/v1")));
  rejects(signedText((d) => (d["body"] = "x".repeat(1024 * 1024 + 1))));
  rejects(signedText((d) => (d["signatures"] = [...(d["signatures"] as unknown[]), ...(d["signatures"] as unknown[])])));
  rejects(signedText((d) => (d["signatures"] = [{ key: coordinatorKey, sig: "x" }])));
  rejects(signedText((d) => (d["signatures"] = [{ key: coordinatorKey, sig: vectors["signature"], extra: 1 }])));
  rejects("не JSON");
  rejects("[]");
  // Неподписанный черновик — допустимый документ.
  parseSignedDocument(JSON.stringify({ format: REGISTRY_FORMAT, body, signatures: [] }), REGISTRY_FORMAT);
});

function bodyWith(change: (b: Record<string, unknown>, group: Record<string, unknown>) => void): string {
  const b = JSON.parse(body) as Record<string, unknown>;
  const group = (b["groups"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  change(b, group);
  return JSON.stringify(b);
}

test("тело: ограничения схемы — отказ format", () => {
  const rejects = (text: string, reason = "format") =>
    assert.throws(
      () => parseRegistryBody(text),
      (error: unknown) => error instanceof RegistryFormatError && error.reason === reason,
    );
  rejects(bodyWith((b) => (b["coordinatorKeys"] = [])));
  rejects(bodyWith((b) => (b["coordinatorKeys"] = Array.from({ length: 9 }, (_, i) => encodeKey(rawPublic(10 + i))))));
  rejects(bodyWith((b) => (b["coordinatorKeys"] = [coordinatorKey, coordinatorKey])));
  rejects(bodyWith((b) => (b["groups"] = [])));
  rejects(bodyWith((b) => (b["groups"] = [...(b["groups"] as unknown[]), ...(b["groups"] as unknown[])])));
  rejects(bodyWith((b) => (b["number"] = 0)));
  rejects(bodyWith((b) => (b["extra"] = 1)));
  rejects(bodyWith((_, g) => (g["extra"] = 1)));
  rejects(bodyWith((_, g) => (g["state"] = "lost")));
  // Действующая Группа без Ретранслятора — своя причина no_relay (NET-17; contracts/http-api.md).
  rejects(bodyWith((_, g) => (g["relays"] = [])), "no_relay");
  rejects(bodyWith((_, g) => (g["relays"] = Array.from({ length: 9 }, (_, i) => ({ url: `https://relay-${i}.test`, tlsSpki: vectors["relayXSpki"] })))));
  rejects(bodyWith((_, g) => (g["relays"] = [{ url: "https://relay-x.test", tlsSpki: vectors["relayXSpki"] }, { url: "https://relay-x.test", tlsSpki: vectors["relayYSpki"] }])));
  for (const url of ["http://relay-x.test", "https://relay-x.test/path", "https://relay-x.test?x=1", "https://relay-x.test#x", "https://u:p@relay-x.test"]) {
    rejects(bodyWith((_, g) => (g["relays"] = [{ url, tlsSpki: vectors["relayXSpki"] }])));
  }
  rejects(bodyWith((_, g) => (g["relays"] = [{ url: "https://relay-x.test", tlsSpki: "x" }])));
  rejects(bodyWith((_, g) => (g["signingKey"] = coordinatorKey + "=")));
  for (const key of ["age1pq1xyz", "age1tag1xyz", "age1xyz", "AGE-SECRET-KEY-1XYZ"]) {
    rejects(bodyWith((_, g) => (g["encryptionKey"] = key)));
  }
  rejects(bodyWith((b) => (b["coordinatingGroup"] = "B")));
  rejects("не JSON");
  // Ретранслятор с портом и без, IP — допустимы; у приостановленной Группы Ретрансляторов может не быть.
  parseRegistryBody(bodyWith((_, g) => (g["relays"] = [{ url: "https://192.0.2.1", tlsSpki: vectors["relayXSpki"] }])));
  parseRegistryBody(bodyWith((_, g) => ((g["state"] = "suspended"), (g["relays"] = []))));
});

test("тело: Код не по NET-51 — отказ code_format", () => {
  const rejects = (text: string) =>
    assert.throws(
      () => parseRegistryBody(text),
      (error: unknown) => error instanceof RegistryFormatError && error.reason === "code_format",
    );
  rejects(bodyWith((b, g) => ((g["code"] = "a1"), (b["coordinatingGroup"] = "a1"))));
  rejects(bodyWith((b, g) => ((g["code"] = "ABCDEFGHI"), (b["coordinatingGroup"] = "ABCDEFGHI"))));
});
