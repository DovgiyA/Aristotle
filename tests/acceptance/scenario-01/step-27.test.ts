// T054 — сценарий 1, шаг 1.27: У1 через CLI регистрирует Материал с видом «Прежний файл» — отказ до
// любой работы с файлом; поставить или снять «Прежний файл» маршрутом — тот же отказ (BANK-61).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../support/harness.ts";
import { materialNetwork, syntheticFile } from "../../support/materials.ts";

test("1.27: «Прежний файл» ставит только Конвертер", async (t) => {
  const { s1, caseId, files } = await materialNetwork(t);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", s1.dir]);
  const refused = await cli("material", "register", syntheticFile(files, "x", 10), "--case", caseId, "--kind", "legacy_file");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Конвертер/);
  assert.equal(existsSync(join(s1.dir, "materials")), false, "файл не копировался");
  const ok = JSON.parse((await cli("material", "register", syntheticFile(files, "y", 10), "--case", caseId, "--kind", "photo", "--json")).stdout) as { id: string };
  const change = await cli("material", "kind", ok.id, "legacy_file");
  assert.equal(change.code, 1);
  assert.match(change.stderr, /Конвертер/);
});
