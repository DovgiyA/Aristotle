// T049 фичи 003 — доверие Ключу Группы только по последней применённой версии Реестра (NET-07).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrustedGroupKey } from "../../src/network/registry.ts";
import { insertRegistryVersion, registryDocument, signDocument, startTestService, testCoordinatorKey } from "../../../../tests/support/harness.ts";

test("NET-07: ключ из действующей версии доверен, из прежней и неизвестный — нет", async (t) => {
  const svc = await startTestService(t);
  const k1 = testCoordinatorKey(1);
  const own = String(svc.db.prepare("SELECT signingKey FROM group_key WHERE current = 1").get()?.["signingKey"]);
  const replaced = testCoordinatorKey(5).publicKey;
  assert.equal(isTrustedGroupKey(svc.db, own), false, "без Реестра не доверен никто");
  insertRegistryVersion(svc.db, signDocument(registryDocument(svc.db, { number: 1, coordinatorKeys: [k1.publicKey] }), k1), svc.seniorId);
  assert.equal(isTrustedGroupKey(svc.db, own), true);
  assert.equal(isTrustedGroupKey(svc.db, replaced), false);
  // Версия 2 со сменой Ключа Группы (как после восстановления, фича 015) — стенд пишет её прямо в БД.
  const v2 = registryDocument(svc.db, { number: 2, coordinatorKeys: [k1.publicKey], change: (_, g) => (g["signingKey"] = replaced) });
  insertRegistryVersion(svc.db, signDocument(v2, k1), svc.seniorId);
  assert.equal(isTrustedGroupKey(svc.db, own), false, "ключ из прежней версии больше не доверен");
  assert.equal(isTrustedGroupKey(svc.db, replaced), true);
});
