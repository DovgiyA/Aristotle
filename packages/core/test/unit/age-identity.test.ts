// T069 фичи 003 — идентичность age X25519 без асинхронных вызовов совместима с age-encryption (typage):
// тот же получатель, шифрование typage расшифровывается этой идентичностью; bech32 отвергает порчу
// (NET-01, NET-41; research R1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { ageRecipientOf, bech32Decode, generateAgeIdentity } from "../../src/network/age-identity.ts";

test("идентичность и получатель совпадают с typage; шифрование туда и обратно", async () => {
  for (let i = 0; i < 20; i++) {
    const { identity, recipient } = generateAgeIdentity();
    assert.match(identity, /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    assert.equal(await identityToRecipient(identity), recipient);
    assert.equal(ageRecipientOf(identity), recipient);
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    assert.equal(new TextDecoder().decode(await decrypter.decrypt(await encrypter.encrypt("v"))), "v");
  }
  // И в обратную сторону: идентичность typage разбирается этим модулем.
  const theirs = await generateX25519Identity();
  assert.equal(ageRecipientOf(theirs), await identityToRecipient(theirs));
});

test("bech32: порча знака, смешанный регистр и чужой префикс — отказ", () => {
  const { identity } = generateAgeIdentity();
  const last = identity.at(-1) === "Q" ? "P" : "Q";
  assert.equal(ageRecipientOf(identity.slice(0, -1) + last), undefined);
  assert.equal(ageRecipientOf(identity.toLowerCase()), undefined, "идентичность — только заглавными");
  assert.equal(bech32Decode(identity.slice(0, 20) + identity.slice(20).toLowerCase()), undefined);
  assert.equal(ageRecipientOf("AGE-PLUGIN-X-1QQQQQQ"), undefined);
});
