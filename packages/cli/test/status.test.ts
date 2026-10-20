// T067 фичи 003, T051 фичи 004 — aristotel status: на Опорной станции Ключ Группы, Реестр, отпечаток
// TLS и Проходы читаются через API сопровождения без автора (APP-34) — отзыв автора из cli.json на
// это не влияет; на Станции — состояние локальной части (contracts/cli.md «aristotel status»).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../../../tests/support/harness.ts";
import { startNetwork, startStation, waitFor } from "../../../tests/support/network.ts";

test("status на Опорной станции и на Станции", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const base = JSON.parse((await runCli(["status", "--json", "--data-dir", net.dir])).stdout) as {
    groupKey: { keyFingerprint: string; state: string } | null;
    registry: { number: number | null; halted: boolean } | null;
    tlsSpki: string | null;
    relays: { url: string; connected: boolean }[] | null;
    activeStations: number | null;
  };
  assert.equal(base.groupKey?.state, "available");
  assert.match(base.groupKey?.keyFingerprint ?? "", /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
  assert.deepEqual(base.registry, { number: 1, halted: false });
  assert.equal(base.tlsSpki, net.server.tls.tlsSpki);
  assert.deepEqual(base.relays?.map((r) => [r.url, r.connected]), [[net.relays[0]!.relay.url, true]]);
  const station = await startStation(t, net);
  const local = await runCli(["status", "--json", "--data-dir", station.dir]);
  assert.equal(local.code, 0, local.stderr);
  const state = JSON.parse(local.stdout).localPart as { unlocked: boolean; memberLabel: string; baseTlsSpki: string; passage: string };
  assert.equal(state.unlocked, true);
  assert.equal(state.memberLabel, "С1");
  assert.equal(state.baseTlsSpki, net.server.tls.tlsSpki);
  assert.equal(state.passage, net.relays[0]!.relay.url);
  const table = await runCli(["status", "--data-dir", station.dir]);
  assert.match(table.stdout, /Локальная часть\s+работает/);
  assert.equal(JSON.parse((await runCli(["status", "--json", "--data-dir", net.dir])).stdout).activeStations, 1);
});
