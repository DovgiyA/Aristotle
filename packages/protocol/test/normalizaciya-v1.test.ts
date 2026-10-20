// T003 — Классы нормализации версии 1 по векторам contracts/normalizaciya-v1.md (DICT-26 … DICT-36,
// DICT-39, DICT-62; research R7 фичи 005). Векторы общие для всех реализаций нормализации.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { domainToASCII } from "node:url";
import { NORM_CLASSES, UNICODE_VERSION, normalize } from "../src/index.ts";

interface Vector {
  class: string;
  input: string;
  output: string | null;
}
const file = JSON.parse(readFileSync(join(import.meta.dirname, "vectors/normalizaciya-v1.json"), "utf8")) as { unicode: string; vectors: Vector[] };
const env = { toAscii: domainToASCII };

test("версия Unicode таблицы NFKC_Casefold — 17.0, как у векторов", () => {
  assert.equal(UNICODE_VERSION, "17.0");
  assert.equal(file.unicode, UNICODE_VERSION);
});

test("десять Классов нормализации версии 1", () => {
  assert.deepEqual(
    [...NORM_CLASSES].sort(),
    ["guid", "hex", "ip", "ssh-ключ", "домен", "имя-хоста", "серийный", "строка", "строка-без-регистра", "целое"].sort(),
  );
});

for (const v of file.vectors) {
  test(`${v.class}: ${JSON.stringify(v.input)} → ${v.output === null ? "не нормализуется" : JSON.stringify(v.output)}`, () => {
    const result = normalize(v.class, v.input, env);
    if (v.output === null) assert.equal(result.ok, false);
    else assert.deepEqual(result, { ok: true, value: v.output });
  });
}

test("NFKC_Casefold — не toLowerCase после NFKC (ß → ss)", () => {
  assert.notEqual("Straße".normalize("NFKC").toLowerCase(), "strasse");
  assert.deepEqual(normalize("строка-без-регистра", "Straße", env), { ok: true, value: "strasse" });
});

test("неизвестный Класс нормализации — ошибка, а не значение", () => {
  assert.throws(() => normalize("имя-хоста/2", "x", env), /имя-хоста\/2/);
});
