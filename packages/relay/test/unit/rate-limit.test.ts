// Ограничитель частоты Ретранслятора: адреса — только в памяти и забываются через 60 с, даже если
// клиент больше не приходит (RELAY-24, research R16 фичи 004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { RateLimit } from "../../src/server.ts";

test("адрес без новых обращений забывается через 60 с", () => {
  let now = 1_000_000;
  const rate = new RateLimit(() => now);
  assert.equal(rate.allow("192.0.2.10"), true);
  assert.equal(rate.size, 1);
  now += 61_000;
  rate.sweep();
  assert.equal(rate.size, 0, "старый адрес не остался в памяти");
});

test("лимит в окне: сверх лимита — отказ; новое окно — снова можно", () => {
  let now = 0;
  const rate = new RateLimit(() => now);
  for (let i = 0; i < 3; i++) assert.equal(rate.allow("192.0.2.11", 3), true);
  assert.equal(rate.allow("192.0.2.11", 3), false);
  now += 61_000;
  assert.equal(rate.allow("192.0.2.11", 3), true);
});

test("Ретранслятор не загружает БД Банка: node:sqlite не подключается (research R1)", () => {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", "await import('@aristotel/relay'); console.log(JSON.stringify(process.moduleLoadList.filter((m) => /sqlite/.test(m))))"], {
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)!), []);
});
