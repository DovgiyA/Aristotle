// T040 фичи 004 — сценарий 9, шаг 9.8: С2 выпускает Приглашение для второй Станции С1; новая
// Станция закреплена за С1 и получает ту же роль (STATION-08, STATION-13, ROLE-09).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMember } from "../../support/harness.ts";
import { acceptOnStand, callStation, invitationKnown, startNetwork, waitFor } from "../../support/network.ts";

test("9.8: вторая Станция С1 по Приглашению С2 — за С1, роль Старшего", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const c2 = addMember(net.server.db, "С2", "senior");
  const issued = await callStation(net, c2, "POST", "/api/invitations", { memberId: net.seniorId });
  assert.equal(issued.statusCode, 201, issued.body);
  await invitationKnown(net, issued.json().invitation);
  const { result } = await acceptOnStand(t, issued.json().invitation);
  assert.equal(result.memberId, net.seniorId);
  assert.equal(result.role, "senior");
  const row = net.server.db.prepare("SELECT memberId, state FROM station WHERE id = ?").get(result.stationId)!;
  assert.deepEqual([row["memberId"], row["state"]], [net.seniorId, "active"]);
});
