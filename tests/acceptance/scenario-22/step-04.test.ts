// T025 — шаг 22.4 в границах фичи 005: подписанная версия подана на Опорную станцию — подпись
// проверена Ключами Координатора текущего Реестра, версия применена без новой версии программы;
// версия и время — в журнале (DICT-01, DICT-16, DICT-17, DICT-18); номер применённой версии доступен
// ядру для пометки публикаций и пакетов (DICT-19; сами пометки — фичи 020, 021). Доставка через Ретрансляторы —
// фича 020.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, callMaintenance, launchTestNetwork, startTestService } from "../../support/harness.ts";
import { TEST_COORDINATOR_SEED, signWithTestCoordinator, testDictionaryDocument } from "../../support/dictionary.ts";

test("22.4: версия применяется автоматически; GET /api/dictionary — номер, SHA-256, кто подписал; журнал dictionary.apply", async (t) => {
  const svc = await startTestService(t);
  const key = launchTestNetwork(svc, undefined, TEST_COORDINATOR_SEED);
  assert.deepEqual((await callAs(svc, svc.seniorId, "GET", "/api/dictionary")).json(), { current: null });
  const doc = signWithTestCoordinator(testDictionaryDocument());
  const res = await callAs(svc, svc.seniorId, "POST", "/api/dictionary/versions", doc);
  assert.equal(res.statusCode, 201, res.body);
  const current = (await callAs(svc, svc.addMember("Н1", "observer"), "GET", "/api/dictionary")).json().current;
  assert.equal(current.number, 1);
  assert.match(current.bodySha256, /^[0-9a-f]{64}$/);
  assert.equal(current.signedBy.key, key.publicKey);
  assert.equal(current.appliedBy.id, svc.seniorId);
  const row = svc.db.prepare("SELECT actorId, details FROM journal WHERE action = 'dictionary.apply'").get();
  assert.equal(row?.["actorId"], svc.seniorId);
  const details = JSON.parse(String(row?.["details"]));
  assert.equal(details.number, 1);
  assert.equal(details.bodySha256, current.bodySha256);
  // DICT-19: номер версии, по которой работает Опорная станция, — для пометки публикаций и пакетов.
  const { dictionaryState } = await import("@aristotel/core");
  assert.equal(dictionaryState(svc.db)?.number, 1);
  // Применённая версия отдаётся байт в байт — её экспортируют для сборки следующей (research R5).
  const text = (await callAs(svc, svc.seniorId, "GET", "/api/dictionary/versions/1")).body;
  assert.equal(JSON.parse(text).body, doc.body);
});

test("22.4, APP-34: через CLI на Опорной станции (API сопровождения) — без подтверждения присутствия, автор — владелец ключа", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc, undefined, TEST_COORDINATOR_SEED);
  const res = await callMaintenance(svc, "POST", "/api/dictionary/versions", signWithTestCoordinator(testDictionaryDocument()));
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(svc.db.prepare("SELECT actorId FROM journal WHERE action = 'dictionary.apply'").get()?.["actorId"], svc.seniorId);
});

test("STATION-12: подача со Станции без подтверждения присутствия — 403 presence_required; Участник — 403", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc, undefined, TEST_COORDINATOR_SEED);
  const doc = signWithTestCoordinator(testDictionaryDocument());
  const raw = await svc.rawInject({ method: "POST", url: "/api/dictionary/versions", headers: { ...svc.authHeaders(svc.seniorId), "content-type": "application/json" }, payload: doc as never });
  assert.equal(raw.json().error, "presence_required");
  const u1 = svc.addMember("У1");
  assert.equal((await callAs(svc, u1, "POST", "/api/dictionary/versions", doc)).statusCode, 403);
  assert.deepEqual((await callAs(svc, svc.seniorId, "GET", "/api/dictionary")).json(), { current: null });
});
