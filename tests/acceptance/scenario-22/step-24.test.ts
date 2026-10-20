// T048 — шаг 22.24: значения типа с Классом «целое» — «1 000» и «1_000» нормализуются в 1000, «1.000» —
// «не нормализуется» и не опознаёт (DICT-36, DICT-39, DICT-62).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase, createTestObject, postIndicator } from "../../support/dictionary.ts";

test("22.24: разделители разрядов класса «целое»", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const radio = await createTestObject(svc, u1, "radio", { case: c.id });
  for (const value of ["1 000", "1_000"]) {
    const r = (await postIndicator(svc, u1, radio.id, "wfb_link_id", { value })).json();
    assert.equal(r.view.normalized, "1000", value);
    assert.equal(r.view.identifying, true, value);
  }
  const dot = (await postIndicator(svc, u1, radio.id, "wfb_link_id", { value: "1.000" })).json();
  assert.equal(dot.view.normalized, null);
  assert.ok(dot.view.marks.includes("not_normalizable"));
  assert.equal(dot.view.identifying, false);
});
