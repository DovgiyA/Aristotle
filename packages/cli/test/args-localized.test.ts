// Ревью, P2 — ошибки разбора флагов CLI по-русски, без текста node:util (конституция VIII, APP-09).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../../../tests/support/harness.ts";

const ENGLISH = /\b(Unknown|option|argument|positional|does not take|missing)\b/;

for (const [args, expected] of [
  [["--zzz"], /неизвестный флаг --zzz/],
  [["init", "--port"], /неверное значение флага --port/],
  [["status", "--json=1"], /неверное значение флага --json/],
] as const) {
  test(`aristotel ${args.join(" ")} — код 1 и русское сообщение`, async () => {
    const result = await runCli([...args]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, ENGLISH, result.stderr);
  });
}
