// T040 фичи 004 — сценарий 9, шаг 9.18: С1 потерял Приглашение для У3 по дороге и отменяет его — без
// повторного ввода пароля, отмена в журнале; предъявленное после отмены — отклоняется (STATION-44).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMember } from "../../support/harness.ts";
import { acceptOnStand, callStation, startNetwork, waitFor } from "../../support/network.ts";

test("9.18: отмена Приглашения без пароля; приём по отменённому — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u3 = addMember(net.server.db, "У3");
  const issued = (await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId: u3 })).json();
  const cancelled = await callStation(net, net.seniorId, "POST", `/api/invitations/${issued.id}/cancel`);
  assert.equal(cancelled.statusCode, 200);
  assert.equal(net.server.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'invitation.cancel'").get()?.["n"], 1);
  await assert.rejects(acceptOnStand(t, issued.invitation), (e: Error) => /invitation_invalid|no_passage/.test(e.message));
  assert.equal(net.server.db.prepare("SELECT count(*) AS n FROM station WHERE memberId = ?").get(u3)?.["n"], 0);
});
