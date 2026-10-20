// T006 фичи 003 — запись журнала от имени службы Опорной станции: actorId = null, подпись автора —
// «служба Опорной станции», фильтр member её не находит, Наблюдатель её видит
// (contracts/http-api.md «Журнал — что изменилось»; research R11; INBOX-30).
import { test } from "node:test";
import assert from "node:assert/strict";
import { message } from "@aristotel/protocol";
import { callAs, startTestService } from "../../../../tests/support/harness.ts";

type Item = { actorId: string | null; actorLabel: string; action: string };

test("запись службы приходит с actorId null и подписью «служба Опорной станции»", async (t) => {
  const svc = await startTestService(t);
  const n1 = svc.addMember("Н1", "observer");
  svc.db
    .prepare("INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES (?, NULL, 'test.service', 'group-key', 'x')")
    .run(new Date().toISOString());

  for (const reader of [svc.seniorId, n1]) {
    const res = await callAs(svc, reader, "GET", "/api/journal?action=test.service");
    assert.equal(res.statusCode, 200, res.body);
    const items = res.json().items as Item[];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.actorId, null);
    assert.equal(items[0]?.actorLabel, message("actor_service"));
    assert.equal(items[0]?.actorLabel, "служба Опорной станции");
  }

  const bySenior = (await callAs(svc, svc.seniorId, "GET", `/api/journal?member=${svc.seniorId}&action=test.service`)).json();
  assert.equal(bySenior.items.length, 0);
});
