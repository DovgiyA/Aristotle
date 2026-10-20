// Ревью фичи 001, P2; T051 фичи 004 — журнал через CLI на Станции доступен целиком: --after продолжает
// с курсора, --all обходит все страницы, а при обрезанном выводе CLI сообщает курсор продолжения
// (INBOX-32, FR-010, APP-08).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../../../tests/support/harness.ts";
import { callStation, startNetwork, startStation, waitFor } from "../../../tests/support/network.ts";

test("journal: курсор продолжения, --after и --all", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const dir = (await startStation(t, net)).dir;
  for (const x of ["v", "w", "y", "z"]) await callStation(net, net.seniorId, "POST", "/api/records", { type: "test.note", fields: { x } });
  // Всего записей — из одного большого запроса: служба, приём Станции, сеанс и 4 создания Записей.
  const total = (JSON.parse((await runCli(["journal", "--json", "--limit", "1000", "--data-dir", dir])).stdout) as unknown[]).length;
  assert.ok(total >= 6, String(total));

  const first = await runCli(["journal", "--json", "--limit", "2", "--data-dir", dir]);
  assert.equal(first.code, 0, first.stderr);
  const page1 = JSON.parse(first.stdout) as Array<{ seq: number }>;
  assert.equal(page1.length, 2);
  const cursor = page1[1]!.seq;
  assert.match(first.stderr, new RegExp(`--after ${cursor}`));

  const second = JSON.parse((await runCli(["journal", "--json", "--limit", "2", "--after", String(cursor), "--data-dir", dir])).stdout) as Array<{ seq: number }>;
  assert.deepEqual(second.map((i) => i.seq > cursor), [true, true]);

  const all = await runCli(["journal", "--json", "--all", "--limit", "2", "--data-dir", dir]);
  assert.equal(all.code, 0, all.stderr);
  const everything = JSON.parse(all.stdout) as Array<{ seq: number }>;
  assert.equal(everything.length, total);
  assert.deepEqual(everything.map((i) => i.seq), [...everything.map((i) => i.seq)].sort((a, b) => a - b));
  assert.doesNotMatch(all.stderr, /--after/);

  const table = await runCli(["journal", "--limit", "2", "--data-dir", dir]);
  assert.equal(table.stdout.trimEnd().split("\n").length, 3);
  assert.match(table.stderr, /--after/);

  const bad = await runCli(["journal", "--after", "x", "--data-dir", dir]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--after/);
});
