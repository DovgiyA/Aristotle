// T003 — контракт contracts/zaverenie-v1.md фичи 006 с векторами: подпись Заверения, схема без вида и
// данных о снятии, отказы разбора и подписи (STATION-29, STATION-32; research R2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AttestationFormatError,
  attestationFileText,
  attestationMessage,
  ed25519FromSeed,
  ed25519Sign,
  isAttestation,
  parseAttestationFile,
  presenceMessage,
  publicKeyText,
  signAttestation,
  verifyAttestationSignature,
  encodeBytes,
  type Attestation,
} from "../src/index.ts";

const V = JSON.parse(readFileSync(join(import.meta.dirname, "vectors", "zaverenie-v1.json"), "utf8"));
const key = ed25519FromSeed(Buffer.from(V.seedHex, "hex"));
const base = V.attestation as Attestation;

function variant(change: { set?: Record<string, unknown>; remove?: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = { ...structuredClone(base), ...(change.set ?? {}) };
  for (const f of change.remove ?? []) delete out[f];
  return out;
}

test("вектор: ключ из семени, SHA-256 содержимого, сообщение и подпись совпадают с контрактом", () => {
  assert.equal(publicKeyText(key), base.stationKey);
  assert.equal(createHash("sha256").update(V.contentUtf8).digest("hex"), base.sha256);
  const message = attestationMessage(base);
  assert.equal(createHash("sha256").update(message).digest("hex"), V.messageSha256);
  const signed = signAttestation((m) => ed25519Sign(key, m), { material: base.material, owner: base.owner, sha256: base.sha256, size: base.size, station: base.station, stationKey: base.stationKey, at: base.at });
  assert.deepEqual(signed, base);
  assert.ok(isAttestation(base));
  assert.ok(verifyAttestationSignature(base));
});

test("схема отвергает вид, данные о снятии, Члена Группы и неканонические поля (STATION-32)", () => {
  for (const c of V.invalid) assert.equal(isAttestation(variant(c)), false, c.name);
});

test("подпись не сходится при изменении любого подписанного поля", () => {
  for (const c of V.badSignature) {
    const a = variant(c) as Attestation;
    assert.ok(isAttestation(a), c.name);
    assert.equal(verifyAttestationSignature(a), false, c.name);
  }
});

test("подпись того же Ключа станции над другим тегом не выдаётся за Заверение", () => {
  const other = presenceMessage({ sessionId: base.material, method: "POST", path: "/api/materials", bodySha256: base.sha256, issuedAt: base.at, nonce: new Uint8Array(16) });
  const forged = { ...base, signature: encodeBytes(ed25519Sign(key, other)) };
  assert.equal(verifyAttestationSignature(forged), false);
});

test("файл Заверения: текст разбирается обратно, мусор и лишние поля — отказ", () => {
  const text = attestationFileText(base);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(parseAttestationFile(text), base);
  assert.throws(() => parseAttestationFile("{"), AttestationFormatError);
  assert.throws(() => parseAttestationFile(JSON.stringify({ ...base, kind: "image" })), AttestationFormatError);
});
