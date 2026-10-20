// T058 (часть CLI) — aristotel form по contracts/cli.md фичи 005 (DATA-23): таблицей и --json; без
// --class — отказ до запроса.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSignedDocument } from "@aristotel/protocol";
import { applyDictionaryVersion } from "@aristotel/core";
import { runCli } from "../../../tests/support/harness.ts";
import { startNetwork, startStation, waitFor } from "../../../tests/support/network.ts";
import { signWithTestCoordinator, testDictionaryDocument } from "../../../tests/support/dictionary.ts";

test("form --class companion — блоки и поля; --json; без --class — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  applyDictionaryVersion(net.server.db, { bySignature: true }, serializeSignedDocument(signWithTestCoordinator(testDictionaryDocument(), net.coordinatorKey)));
  const station = await startStation(t, net);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", station.dir]);
  const table = await cli("form", "--class", "companion");
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /Имя хоста/);
  // T167: блоки — по-русски.
  assert.match(table.stdout, /Носитель/);
  assert.doesNotMatch(table.stdout, /\bheader\b|\bmedia\b/);
  const json = JSON.parse((await cli("form", "--class", "radio_module", "--on-linux", "--json")).stdout) as { blocks: { block: string }[] };
  assert.deepEqual(json.blocks.map((b) => b.block), ["header", "media", "class", "os"]);
  assert.equal((await cli("form")).code, 1);
});

test("T262: form показывает «устаревшее» поле и тип значения", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const { T } = await import("../../../tests/support/dictionary.ts");
  const doc = testDictionaryDocument({ change: (b) => (b.elements.find((e) => e.id === T.indicator("hostname"))!.state = "deprecated") });
  applyDictionaryVersion(net.server.db, { bySignature: true }, serializeSignedDocument(signWithTestCoordinator(doc, net.coordinatorKey)));
  const station = await startStation(t, net);
  const table = await runCli(["form", "--class", "companion", "--data-dir", station.dir]);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /Имя хоста.*устарел/);
  assert.match(table.stdout, /Имя хоста.*имя хоста/);
});

test("T282: form печатает общую часть Кейса", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  applyDictionaryVersion(net.server.db, { bySignature: true }, serializeSignedDocument(signWithTestCoordinator(testDictionaryDocument(), net.coordinatorKey)));
  const station = await startStation(t, net);
  const json = JSON.parse((await runCli(["form", "--class", "companion", "--json", "--data-dir", station.dir])).stdout) as { general: { label: string }[] };
  const table = (await runCli(["form", "--class", "companion", "--data-dir", station.dir])).stdout;
  for (const g of json.general) assert.ok(table.includes(g.label), g.label);
});
