// T062 — шаг 22.23: Код местного типа — Код Группы, двоеточие и код snake_case (DICT-11, DICT-61).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, proposeLocal } from "../../support/dictionary.ts";

test("22.23: С1 принимает предложенный У1 тип radio_quirk — Код A:radio_quirk; Код не snake_case — отказ", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const ok = await proposeLocal(svc, u1, "type", { code: "radio_quirk", label: "x", object: T.object("radio"), format: "строка:64" });
  assert.equal(ok.statusCode, 200, ok.body);
  const code = svc.db.prepare("SELECT code FROM dict_element WHERE id = ?").get(ok.json().resultId)?.["code"];
  assert.equal(code, "A:radio_quirk");
  const bad = await proposeLocal(svc, u1, "type", { code: "Radio-Quirk", label: "x", object: T.object("radio"), format: "строка:64" }, false);
  assert.equal(bad.statusCode, 400);
});
