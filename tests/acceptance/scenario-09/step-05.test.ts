// T040 фичи 004 — сценарий 9, шаг 9.5: У3 предъявляет Приглашение — Станция создала Ключ станции под
// паролем и пришла через Проход с секретом и открытым ключом; Опорная станция закрепила её за У3 и
// обновила перечень Прохода; С1 видит «Станция принята» с отпечатком (STATION-04, STATION-09,
// STATION-16). Приглашение после смены Ретрансляторов — через оставшийся Проход (spec Edge Cases).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyFingerprint, parseInvitation } from "@aristotel/protocol";
import { addMember } from "../../support/harness.ts";
import { acceptOnStand, callStation, invitationKnown, prepareRelay, importRegistry, startNetwork, waitFor } from "../../support/network.ts";

test("9.5: приём через Проход; перечень Прохода обновлён; С1 видит Станцию с отпечатком", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u3 = addMember(net.server.db, "У3");
  const issued = await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId: u3 });
  assert.equal(issued.statusCode, 201, issued.body);
  await invitationKnown(net, issued.json().invitation);
  const { result } = await acceptOnStand(t, issued.json().invitation);
  assert.equal(result.memberId, u3);
  await waitFor(() => net.relays[0]!.server!.passages.listOf("A").some((e) => e.key === result.stationKey), 3000, "перечень Прохода");
  const stations = (await callStation(net, net.seniorId, "GET", "/api/stations")).json().items as { memberLabel: string; view: string; keyFingerprint: string }[];
  const mine = stations.find((s) => s.keyFingerprint === keyFingerprint(result.stationKey));
  assert.ok(mine);
  assert.equal(mine.memberLabel, "У3");
  assert.equal(mine.view, "active");
});

test("Приглашение выпущено, затем Реестр сменил Ретрансляторы: приём через оставшийся Проход; ни одного — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 2 });
  await waitFor(() => net.relays.every((r) => r.server!.passages.hasControl("A")));
  const u3 = addMember(net.server.db, "У3");
  const u4 = addMember(net.server.db, "У4");
  const first = (await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId: u3 })).json().invitation;
  const second = (await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId: u4 })).json().invitation;
  assert.equal(parseInvitation(first).passages.length, 2);
  await invitationKnown(net, first);
  // Новая версия оставляет только R2: R1 Опорная станция покидает.
  await net.publish([net.relays[1]!.relay]);
  await net.relays[0]!.stop();
  const { result } = await acceptOnStand(t, first);
  assert.equal(result.memberId, u3);
  // Новая версия убирает и R2, ставит R3 — в Приглашении не осталось действующих Проходов.
  const r3 = await prepareRelay(t);
  const doc = await net.publish([r3.relay]);
  importRegistry(r3, doc);
  await r3.start();
  await net.relays[1]!.stop();
  await assert.rejects(acceptOnStand(t, second), /no_passage/);
});
