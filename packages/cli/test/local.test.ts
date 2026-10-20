// T064 (часть CLI) — aristotel local по contracts/cli.md фичи 005: propose, proposals, accept, reject
// --reason, show — таблицей и --json; reject без --reason — отказ CLI до запроса (DICT-05, DICT-45).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeSignedDocument } from "@aristotel/protocol";
import { applyDictionaryVersion } from "@aristotel/core";
import { runCli } from "../../../tests/support/harness.ts";
import { startNetwork, startStation, tempDir, waitFor } from "../../../tests/support/network.ts";
import { T, signWithTestCoordinator, testDictionaryDocument } from "../../../tests/support/dictionary.ts";

test("local propose → accept, reject --reason; show и proposals --json", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  applyDictionaryVersion(net.server.db, { bySignature: true }, serializeSignedDocument(signWithTestCoordinator(testDictionaryDocument(), net.coordinatorKey)));
  const station = await startStation(t, net);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", station.dir]);
  const dir = tempDir(t);
  const typeFile = join(dir, "type.json");
  writeFileSync(typeFile, JSON.stringify({ code: "x_quirk", label: "x", object: T.object("operator"), format: "строка:64" }));
  const proposed = JSON.parse((await cli("local", "propose", "type", "--json-payload", typeFile, "--json")).stdout) as { id: string; state: string };
  assert.equal(proposed.state, "proposed");
  const accepted = await cli("local", "accept", proposed.id, "--json");
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).state, "accepted");
  const again = await cli("local", "propose", "type", "--json-payload", typeFile);
  assert.equal(again.code, 1, "Код A:x_quirk уже занят");
  const rowFile = join(dir, "row.json");
  writeFileSync(rowFile, JSON.stringify({ type: T.indicator("username"), kind: "value", value: "x", note: "типовая учётка" }));
  const row = JSON.parse((await cli("local", "propose", "stop_list_entry", "--json-payload", rowFile, "--json")).stdout) as { id: string };
  assert.equal((await cli("local", "reject", row.id)).code, 1, "без --reason");
  const rejected = await cli("local", "reject", row.id, "--reason", "x", "--json");
  assert.equal(JSON.parse(rejected.stdout).state, "rejected");
  const show = await cli("local", "show");
  assert.match(show.stdout, /A:x_quirk/);
  const list = JSON.parse((await cli("local", "proposals", "--state", "rejected", "--json")).stdout) as { items: { id: string }[] };
  assert.deepEqual(list.items.map((p) => p.id), [row.id]);
  // T139: show печатает Идентификатор строки «Местного» — его называет предложение удаления { remove }.
  const kept = JSON.parse((await cli("local", "propose", "stop_list_entry", "--json-payload", rowFile, "--json")).stdout) as { id: string };
  const entryId = JSON.parse((await cli("local", "accept", kept.id, "--json")).stdout).resultId as string;
  assert.match((await cli("local", "show")).stdout, new RegExp(entryId));
  const removeFile = join(dir, "remove.json");
  writeFileSync(removeFile, JSON.stringify({ remove: entryId }));
  const removal = JSON.parse((await cli("local", "propose", "stop_list_entry", "--json-payload", removeFile, "--json")).stdout) as { id: string };
  const removed = await cli("local", "accept", removal.id);
  assert.equal(removed.code, 0);
  assert.match(removed.stdout, /Удалено\s+/, "T159: принятие удаления — «Удалено», не «Создано»");
  assert.doesNotMatch(removed.stdout, /Создано/);
  assert.doesNotMatch((await cli("local", "show")).stdout, new RegExp(entryId));
  // T160: show печатает и значения перечней, поля шаблона и ужесточения Местного расширения.
  const valueFile = join(dir, "value.json");
  writeFileSync(valueFile, JSON.stringify({ enum: "os_distro", code: "x_distro", label: "Икс" }));
  const value = JSON.parse((await cli("local", "propose", "enum_value", "--json-payload", valueFile, "--json")).stdout) as { id: string };
  assert.equal((await cli("local", "accept", value.id)).code, 0);
  const overrideFile = join(dir, "override.json");
  writeFileSync(overrideFile, JSON.stringify({ element: T.indicator("username"), property: "autoSecret", value: true }));
  const override = JSON.parse((await cli("local", "propose", "override", "--json-payload", overrideFile, "--json")).stdout) as { id: string };
  assert.equal((await cli("local", "accept", override.id)).code, 0);
  const full = (await cli("local", "show")).stdout;
  assert.match(full, /x_distro/);
  // T167: правило, вид и состояние предложения — по-русски.
  assert.match(full, /автоматический Секрет/);
  assert.doesNotMatch(full, /autoSecret/);
  // T173: значение ужесточения и блок поля шаблона — по-русски.
  assert.match(full, /автоматический Секрет\s+да/);
  assert.doesNotMatch(full, /\btrue\b/);
  const fieldFile = join(dir, "field.json");
  writeFileSync(fieldFile, JSON.stringify({ class: "companion", block: "media", label: "Поле Группы", indicatorType: JSON.parse(accepted.stdout).resultId }));
  const field = JSON.parse((await cli("local", "propose", "template_field", "--json-payload", fieldFile, "--json")).stdout) as { id: string };
  assert.equal((await cli("local", "accept", field.id)).code, 0);
  const withField = (await cli("local", "show")).stdout;
  assert.match(withField, /Носитель\s+Поле Группы/);
  assert.doesNotMatch(withField, /\bmedia\b/);
  // T229: Коды, а не Идентификаторы; состояние местного типа; суть предложения в списке.
  assert.match(withField, /companion\s+—\s+Носитель\s+Поле Группы/);
  assert.match(full, /os_distro\s+x_distro/);
  assert.doesNotMatch(full, new RegExp(T.enumOf("os_distro")));
  assert.match(full, /A:x_quirk\s+x\s+действует/);
  const proposals = (await cli("local", "proposals")).stdout;
  assert.match(proposals, /x_quirk/);
  // T296: вид строки «Местного» — по-русски, и в списке предложений, и в show.
  assert.match(proposals, /значение username x/);
  assert.doesNotMatch(proposals, /\bvalue\b/);
  assert.match(proposals, /местный тип/);
  assert.match(proposals, /принято/);
  assert.doesNotMatch(proposals, /\baccepted\b|\bstop_list_entry\b/);
  // T253: суть называет элемент ужесточения и тип строки Кодом, перечень — Кодом, а не Идентификатором.
  assert.match(proposals, /username\s+автоматический Секрет да/);
  assert.match(proposals, /username\s+x/);
  assert.doesNotMatch(proposals, new RegExp(T.indicator("username")));
  // T254: local show — формат местного типа; dictionary elements — вид в единственном числе, уровень и
  // эффективные свойства (ужесточение Группы видно).
  assert.match((await cli("local", "show")).stdout, /строка:64/);
  const rowAgain = JSON.parse((await cli("local", "propose", "stop_list_entry", "--json-payload", rowFile, "--json")).stdout) as { id: string };
  assert.equal((await cli("local", "accept", rowAgain.id)).code, 0);
  const shown = (await cli("local", "show")).stdout;
  assert.match(shown, /username\s+значение\s+x/);
  const elements = (await cli("dictionary", "elements", "--code", "username")).stdout;
  assert.match(elements, /тип Индикатора/);
  assert.doesNotMatch(elements, /типов Индикаторов/);
  assert.match(elements, /автоматический Секрет/);
  assert.match(elements, /Сеть/);
});

test("T215: local propose без файла, с не-JSON или не объектом — причина с именем файла и код 1", async (t) => {
  const { emptyDataDir } = await import("../../../tests/support/harness.ts");
  const dir = emptyDataDir(t);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{bad");
  const list = join(dir, "list.json");
  writeFileSync(list, "[1]");
  for (const file of [join(dir, "missing.json"), bad, list]) {
    const res = await runCli(["local", "propose", "type", "--json-payload", file, "--data-dir", dir]);
    assert.equal(res.code, 1, res.stderr);
    assert.ok(res.stderr.includes(file), res.stderr);
    assert.doesNotMatch(res.stderr, /непредвиденная ошибка/);
  }
});
