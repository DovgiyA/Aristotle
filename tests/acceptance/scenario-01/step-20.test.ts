// T051 — сценарий 1, шаг 1.20 в части фичи 006: Материал, зарегистрированный через CLI без вида, —
// Запись принята, признак неполноты «вида нет» (BANK-59, INTAKE-06; Clarifications). Блокировка
// отправки на Проверку — фичи 008, 010.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../../support/harness.ts";
import { materialNetwork, syntheticFile } from "../../support/materials.ts";

test("1.20: Материал через CLI без вида — принят, incomplete: kind", async (t) => {
  const { s1, caseId, files } = await materialNetwork(t);
  const res = await runCli(["material", "register", syntheticFile(files, "x.img", 10), "--case", caseId, "--json", "--data-dir", s1.dir]);
  assert.equal(res.code, 0, res.stderr);
  const record = JSON.parse(res.stdout).record as { fields: { kind: unknown }; view: { incomplete: string[] } };
  assert.equal(record.fields.kind, null);
  assert.deepEqual(record.view.incomplete, ["kind"]);
});
