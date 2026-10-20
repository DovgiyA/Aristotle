// T071 фичи 004 — CLI вида «Станции» на Станции Старшего: stations, stations revoke <id> [--handover]
// без пароля (contracts/cli.md; VIEW-47, STATION-17, STATION-20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMember, runCli } from "../../../tests/support/harness.ts";
import { startNetwork, startStation, waitFor } from "../../../tests/support/network.ts";

test("stations, stations revoke и --handover; Участнику — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const c1 = await startStation(t, net);
  const u1 = addMember(net.server.db, "У1");
  const lost = await startStation(t, net, u1, { unlock: false });
  const handed = await startStation(t, net, u1);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", c1.dir]);
  const list = await cli("stations", "--json");
  assert.equal(list.code, 0, list.stderr);
  const items = JSON.parse(list.stdout) as { id: string; memberLabel: string; view: string }[];
  assert.deepEqual(items.filter((s) => s.memberLabel === "У1").map((s) => s.view), ["active", "active"]);
  const table = await cli("stations");
  assert.match(table.stdout, /действует/);
  assert.match(table.stdout, /У1/);
  // Вид «Станции» — только Старшим (VIEW-47).
  const participant = await runCli(["stations", "--data-dir", handed.dir]);
  assert.equal(participant.code, 1);
  assert.match(participant.stderr, /Вашей роли это действие не разрешено/);
  const revoked = await cli("stations", "revoke", lost.result.stationId, "--json");
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.equal(JSON.parse(revoked.stdout).view, "delete-only");
  const handover = await cli("stations", "revoke", handed.result.stationId, "--handover");
  assert.equal(handover.code, 0, handover.stderr);
  assert.match(handover.stdout, /только удаление: осталось 90 дн\., до /);
  assert.match(handover.stdout, /Идентификатор/);
  await waitFor(() => handed.server.part.deleted, 10_000, "сдача завершена");
  const again = await cli("stations", "revoke", lost.result.stationId);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /уже отозвана/);
});
