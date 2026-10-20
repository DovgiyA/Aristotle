// T024, T036, T050, T056, T063 — команды aristotel material (contracts/cli.md фичи 006): регистрация,
// показ, список, очередь доставки, повторное Заверение, вид (выпуск образа — с паролем), удаление.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runCli, writePasswordFile } from "../../../tests/support/harness.ts";
import { materialNetwork, syntheticFile } from "../../../tests/support/materials.ts";
import { TEST_STATION_PASSWORD, startStation } from "../../../tests/support/network.ts";

test("material register / show / list / status --wait — на Станции через сеанс", async (t) => {
  const { s1, caseId, files } = await materialNetwork(t);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", s1.dir]);
  const file = syntheticFile(files, "x.img", 2000);
  const reg = await cli("material", "register", file, "--case", caseId);
  assert.equal(reg.code, 0, reg.stderr);
  assert.match(reg.stdout, /вида нет/);
  assert.match(reg.stdout, /не доставлен/);
  const json = JSON.parse((await cli("material", "register", file, "--case", caseId, "--path", "y.img", "--kind", "image", "--json")).stdout) as { id: string };
  const status = await cli("material", "status", "--wait");
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /доставлен/);
  const shown = await cli("material", "show", json.id, "--attestations");
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /image/);
  assert.match(shown.stdout, new RegExp(s1.result.stationId));
  const list = JSON.parse((await cli("material", "list", "--case", caseId, "--json")).stdout) as { id: string }[];
  assert.equal(list.length, 2);
  const legacy = await cli("material", "register", file, "--case", caseId, "--path", "z.img", "--kind", "legacy_file");
  assert.equal(legacy.code, 1);
  assert.match(legacy.stderr, /Конвертер/);
  assert.equal((await cli("material", "list")).code, 1);
});

test("material kind и delete: Участнику — отказ; Старший с паролем выпускает образ и удаляет", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  const cli = (dir: string, ...args: string[]) => runCli([...args, "--data-dir", dir]);
  const reg = JSON.parse((await cli(s1.dir, "material", "register", syntheticFile(files, "k.img", 100), "--case", caseId, "--kind", "image", "--json")).stdout) as { id: string };
  const refused = await cli(s1.dir, "material", "kind", reg.id, "extracted_file");
  assert.equal(refused.code, 1);
  const c1 = await startStation(t, net);
  const password = writePasswordFile(join(files, "c1-password"), TEST_STATION_PASSWORD);
  const released = await cli(c1.dir, "material", "kind", reg.id, "extracted_file", "--password-file", password);
  assert.equal(released.code, 0, released.stderr);
  assert.match(released.stderr, /начнёт уходить Держателям/);
  assert.equal((await cli(s1.dir, "material", "delete", reg.id, "--reason", "дубль")).code, 1);
  const deleted = await cli(c1.dir, "material", "delete", reg.id, "--reason", "дубль");
  assert.equal(deleted.code, 0, deleted.stderr);
  const withDeleted = JSON.parse((await cli(s1.dir, "material", "list", "--case", caseId, "--deleted", "--json")).stdout) as { view: { deleted: unknown } }[];
  assert.equal(withDeleted.length, 1);
  assert.notEqual(withDeleted[0]!.view.deleted, null);
  assert.equal(JSON.parse((await cli(s1.dir, "material", "list", "--case", caseId, "--json")).stdout).length, 0);
  const byStation = await cli(c1.dir, "material", "list", "--station", s1.result.stationId, "--json");
  assert.equal(byStation.code, 0, byStation.stderr);
});
