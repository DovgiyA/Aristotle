// T043 (часть CLI) — aristotel record create --type case и case show на Станции через сеанс
// (contracts/cli.md фичи 005; BANK-26, DATA-27); на Опорной станции — только сопровождение (APP-34).
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSignedDocument } from "@aristotel/protocol";
import { applyDictionaryVersion } from "@aristotel/core";
import { runCli } from "../../../tests/support/harness.ts";
import { startNetwork, startStation, waitFor } from "../../../tests/support/network.ts";
import { EV, signWithTestCoordinator, testDictionaryDocument } from "../../../tests/support/dictionary.ts";

test("record create --type case — Номер в выводе; case show — таблицей и --json", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  applyDictionaryVersion(net.server.db, { bySignature: true }, serializeSignedDocument(signWithTestCoordinator(testDictionaryDocument(), net.coordinatorKey)));
  const station = await startStation(t, net);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", station.dir]);
  const created = await cli("record", "create", "--type", "case", "--fields", JSON.stringify({ shape: EV("case_shape", "single_item"), designation: "x" }));
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, new RegExp(`Номер Кейса\\s+${new Date().getUTCFullYear()}-001`));
  const json = await cli("record", "create", "--type", "case", "--fields", "{}", "--json");
  const id = JSON.parse(json.stdout).id as string;
  const shown = await cli("case", "show", id);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /-002/);
  // T167: статус и неотвеченные поля — по-русски.
  assert.match(shown.stdout, /Дата изъятия/);
  assert.match(shown.stdout, /черновик/);
  assert.doesNotMatch(shown.stdout, /seizedAt|draft/);
  const asJson = JSON.parse((await cli("case", "show", id, "--json")).stdout) as { label: string; answered: { complete: boolean } };
  assert.equal(asJson.answered.complete, false);
  // T072: журнал по Кейсу в CLI (INBOX-32).
  const byCase = JSON.parse((await cli("journal", "--case", id, "--json")).stdout) as { caseId: string }[];
  assert.ok(byCase.length > 0 && byCase.every((i) => i.caseId === id));
  assert.equal((await cli("journal", "--case", id)).code, 0);
  const bad = await cli("record", "create", "--type", "case", "--fields", "[1]");
  assert.equal(bad.code, 1);
  const onBase = await runCli(["case", "show", id, "--data-dir", net.dir]);
  assert.equal(onBase.code, 1);
  assert.match(onBase.stderr, /Станции/);
});
