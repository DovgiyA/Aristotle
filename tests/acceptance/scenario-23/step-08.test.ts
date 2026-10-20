// T047 фичи 003 — сценарий 23, шаг 23.8: версия с номером меньше известного не применяется; пропуск
// номеров допустим; повтор применённой — без изменений (NET-09; spec.md US4, сценарий 3; Edge Cases).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, insertCoordinatorKey, registryDocument, RELAY_Y, signDocument, startTestService, testCoordinatorKey } from "../../support/harness.ts";

test("23.8: применены 1 и 3; версия 2 — registry_stale; повтор 3 — 200", async (t) => {
  const svc = await startTestService(t);
  const c1 = svc.seniorId;
  const k1 = testCoordinatorKey(1);
  insertCoordinatorKey(svc.db, c1, k1.publicKey);
  const version = (number: number, relays?: typeof RELAY_Y[]) =>
    signDocument(registryDocument(svc.db, { number, coordinatorKeys: [k1.publicKey], ...(relays === undefined ? {} : { relays }) }), k1);
  const apply = (doc: unknown) => callAs(svc, c1, "POST", "/api/registry/versions", doc);

  assert.equal((await apply(version(1))).statusCode, 201);
  const v3 = version(3, [RELAY_Y]);
  assert.equal((await apply(v3)).statusCode, 201, "номер больше известного — применяется, хоть 2 и пропущен");

  const stale = await apply(version(2));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, "registry_stale");
  const journal = svc.db.prepare("SELECT details FROM journal WHERE action = 'registry.reject'").all();
  assert.deepEqual(JSON.parse(String(journal.at(-1)?.["details"])), { reason: "stale", number: 2 });

  const again = await apply(v3);
  assert.equal(again.statusCode, 200);
  assert.equal((await callAs(svc, c1, "GET", "/api/registry")).json().current.number, 3);
});
