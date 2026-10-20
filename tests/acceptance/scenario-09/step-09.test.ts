// T040 фичи 004 — сценарий 9, шаг 9.9: У1 пытается выпустить Приглашение; С1 — Приглашение для своей
// Станции. Отказ обоим (STATION-13, STATION-14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, groupA, launchTestNetwork, startTestService } from "../../support/harness.ts";

test("9.9: Приглашение от Участника и себе — отказ", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc);
  const a = groupA(svc.db, svc.seniorId);
  const byParticipant = await callAs(svc, a.u1, "POST", "/api/invitations", { memberId: a.u2 });
  assert.equal(byParticipant.statusCode, 403);
  assert.equal(byParticipant.json().error, "forbidden");
  const self = await callAs(svc, a.c1, "POST", "/api/invitations", { memberId: a.c1 });
  assert.equal(self.statusCode, 403);
  assert.equal(self.json().error, "invitation_self");
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM invitation WHERE acceptKeyHash <> 'test'").get()?.["n"], 0);
});
