// T062 — шаг 22.21: снять автоматический Секрет, сделать сопоставляемым или строгим — отказ; ослабить
// строгость и добавить значение в Стоп-лист — можно (DICT-07).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
import { T, applyTestDictionary, proposeLocal } from "../../support/dictionary.ts";

test("22.21: первые три — отказ, последние два — можно", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const s1 = svc.seniorId;
  const ask = (payload: Record<string, unknown>) => callAs(svc, s1, "POST", "/api/local-extension/proposals", { kind: "override", payload });
  assert.equal((await ask({ element: T.indicator("recovered_password"), property: "autoSecret", value: false })).json().error, "local_weakening");
  assert.equal((await ask({ element: T.indicator("os_note"), property: "comparable", value: true })).json().error, "local_weakening");
  assert.equal((await ask({ element: T.indicator("username"), property: "identifying", value: "strict" })).json().error, "local_weakening");
  assert.equal((await proposeLocal(svc, s1, "override", { element: T.indicator("domain"), property: "identifying", value: "loose" })).statusCode, 200);
  assert.equal((await proposeLocal(svc, s1, "stop_list_entry", { type: T.indicator("domain"), kind: "value", value: "x.test", note: "x" })).statusCode, 200);
});
