// T005 — совпадение со строками Стоп-листа трёх видов: значение, диапазон (только `ip`), шаблон
// (glob `*` и `?`) по нормализованной форме (research R9 фичи 005; DICT-41).
import { test } from "node:test";
import assert from "node:assert/strict";
import { StopListMatcherError, buildStopListMatcher, type StopListEntryInput } from "../src/index.ts";

const T_IP = "t-ip";
const T_HOST = "t-host";
const T_ZT = "t-zt";
const ipClass = (typeId: string) => (typeId === T_IP ? "ip" : "строка");

const entries: StopListEntryInput[] = [
  { id: "e1", typeId: T_IP, kind: "range", normalized: "10.0.0.0/8" },
  { id: "e2", typeId: T_IP, kind: "range", normalized: "2001:db8::/32" },
  { id: "e3", typeId: T_IP, kind: "value", normalized: "8.8.8.8" },
  { id: "e4", typeId: T_HOST, kind: "pattern", normalized: "orangepi*" },
  { id: "e5", typeId: T_ZT, kind: "pattern", normalized: "ff????????000000" },
  { id: "e6", typeId: T_HOST, kind: "pattern", normalized: "[x]*" },
];
const matcher = buildStopListMatcher(entries, ipClass);

test("значение — равенство нормализованных форм того же типа", () => {
  assert.equal(matcher.match(T_IP, "8.8.8.8")?.id, "e3");
  assert.equal(matcher.match(T_HOST, "8.8.8.8"), undefined);
});

test("диапазон — CIDR IPv4 и IPv6", () => {
  assert.equal(matcher.match(T_IP, "10.1.2.3")?.id, "e1");
  assert.equal(matcher.match(T_IP, "11.0.0.1"), undefined);
  assert.equal(matcher.match(T_IP, "2001:db8::1")?.id, "e2");
  assert.equal(matcher.match(T_IP, "2001:db9::1"), undefined);
});

test("шаблон — glob: `*` любая строка, `?` один символ, `[` и `]` — обычные символы", () => {
  assert.equal(matcher.match(T_HOST, "orangepi5")?.id, "e4");
  assert.equal(matcher.match(T_HOST, "orangepi")?.id, "e4");
  assert.equal(matcher.match(T_HOST, "nanopi"), undefined);
  assert.equal(matcher.match(T_ZT, "ff12345678000000")?.id, "e5");
  assert.equal(matcher.match(T_ZT, "ff1234567000000"), undefined);
  assert.equal(matcher.match(T_HOST, "[x]y")?.id, "e6");
  assert.equal(matcher.match(T_HOST, "xy"), undefined);
});

test("диапазон у типа не с Классом `ip` — ошибка построения (DICT-41)", () => {
  assert.throws(() => buildStopListMatcher([{ id: "e", typeId: T_HOST, kind: "range", normalized: "10.0.0.0/8" }], ipClass), StopListMatcherError);
});

test("40 000 строк-значений одного типа — поиск по индексу, а не перебором", () => {
  const many: StopListEntryInput[] = Array.from({ length: 40_000 }, (_, i) => ({ id: `v${i}`, typeId: T_HOST, kind: "value", normalized: `v${i}` }));
  const big = buildStopListMatcher(many, ipClass);
  const started = performance.now();
  for (let i = 0; i < 40_000; i++) assert.equal(big.match(T_HOST, `v${i}`)?.id, `v${i}`);
  assert.ok(performance.now() - started < 500);
});
