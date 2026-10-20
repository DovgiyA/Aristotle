// T016 фичи 003 — GET /api/group-key: открытые Ключи Группы и отпечаток для всех ролей, секретной
// части в ответе нет (contracts/http-api.md; NET-41, NET-42, FR-004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeKey, isAgeX25519Recipient, keyFingerprint } from "@aristotel/protocol";
import { callAs, groupA, startTestService } from "../../../../tests/support/harness.ts";

test("открытые Ключи Группы и отпечаток — всем ролям, одинаково", async (t) => {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const answers = [];
  for (const reader of [a.u1, a.c1, a.n1]) {
    const res = await callAs(svc, reader, "GET", "/api/group-key");
    assert.equal(res.statusCode, 200, res.body);
    answers.push(res.json());
  }
  const info = answers[0];
  assert.deepEqual(answers[1], info);
  assert.deepEqual(answers[2], info);
  assert.deepEqual(Object.keys(info).sort(), ["createdAt", "encryptionKey", "keyFingerprint", "signingKey", "state"]);
  assert.equal(decodeKey(info.signingKey)?.length, 32);
  assert.ok(!info.signingKey.includes("="));
  assert.ok(info.encryptionKey.startsWith("age1"));
  assert.ok(isAgeX25519Recipient(info.encryptionKey));
  assert.equal(info.keyFingerprint, keyFingerprint(info.signingKey));
  assert.equal(info.state, "available");
  assert.ok(!/AGE-SECRET-KEY|pkcs8|PRIVATE/i.test(JSON.stringify(info)));
});
