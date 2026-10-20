// T075 — замер SC-002 работает: уменьшенный прогон bench/dictionary.ts (полный — npm run bench:dictionary).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBench } from "../../../bench/dictionary.ts";

test("замер SC-002: версия 1 и версия только со Стоп-листом применяются, времена измерены", async () => {
  const r = await runBench({ listRows: [10, 20, 30], values: 500 });
  assert.equal(r.stopListRows, 171 + 60);
  assert.ok(r.applyV1Ms > 0 && r.applyStopOnlyMs > 0);
});
