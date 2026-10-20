// T040 фичи 004 — сценарий 9, шаг 9.10: Приглашение предъявлено повторно или после срока — отказ
// (STATION-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMember } from "../../support/harness.ts";
import { acceptOnStand, callStation, startNetwork, waitFor } from "../../support/network.ts";

test("9.10: повторное и просроченное Приглашение — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u3 = addMember(net.server.db, "У3");
  const once = (await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId: u3 })).json().invitation;
  await acceptOnStand(t, once);
  await assert.rejects(acceptOnStand(t, once), (e: Error) => /invitation_invalid|no_passage/.test(e.message));
  const late = (await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId: u3 })).json();
  net.server.db.prepare("UPDATE group_setting SET value = 1 WHERE key = 'invitationHours'").run();
  // Срок по часам Опорной станции: сдвигаем срок Приглашения в прошлое вместо часов процесса.
  net.server.db.exec("DROP TRIGGER invitation_only_from_issued");
  net.server.db.prepare("UPDATE invitation SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(late.id);
  await assert.rejects(acceptOnStand(t, late.invitation), (e: Error) => /invitation_invalid|no_passage/.test(e.message));
});
