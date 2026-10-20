// T022 — исходник Словаря Сети версии 1 (dictionary/source/) совпадает с выводом генератора по текущему
// приложению «Словарь Сети v1», счётчики — с приложением (SC-001; NET-16, DICT-02, DICT-04, DATA-05;
// конституция, принцип I). Внешние перечни генератор берёт из уже собранного enums.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromAppendix, sourceFiles } from "../../tools/slovar/from-appendix.ts";
import type { SourceEnum } from "@aristotel/protocol";

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE = join(ROOT, "dictionary", "source");
const appendix = readFileSync(join(ROOT, "docs/spec/slovar-seti-v1.md"), "utf8");
const previous = JSON.parse(readFileSync(join(SOURCE, "enums.json"), "utf8")) as SourceEnum[];
const src = fromAppendix(appendix, undefined, previous);

test("dictionary/source совпадает с выводом генератора байт в байт", () => {
  for (const [path, text] of sourceFiles(src)) assert.equal(readFileSync(join(SOURCE, path), "utf8"), text, path);
});

test("счётчики — как в приложении: §1, §2, §3, §6, §7, §9", () => {
  assert.equal(src.types.objectTypes.length, 13, "13 типов объектов и Изделие (Изделие — Запись item, не тип объекта)");
  assert.equal(src.types.linkTypes.length, 18);
  const types = src.types.indicatorTypes;
  assert.equal(types.length, 105);
  // «Итого» §6: 105 типов, из них 36 сопоставляемых и 4 с автоматическим Секретом.
  assert.equal(types.filter((t) => t.comparable).length, 36);
  assert.equal(types.filter((t) => t.autoSecret).length, 4);
  assert.equal(src.enums.length, 34);
  const itemClass = src.enums.find((e) => e.code === "item_class")!;
  assert.deepEqual(itemClass.values.map((v) => v.code), ["companion", "flight_controller", "radio_module"]);
  assert.equal(itemClass.closed, true);
  assert.deepEqual(src.enums.find((e) => e.code === "item_subtype")!.values.map((v) => v.code), ["bare_media"]);
  assert.deepEqual(
    src.enums.filter((e) => e.closed).map((e) => e.code).sort(),
    ["acquisition_method", "case_shape", "extraction_status", "item_class", "item_subtype", "material_kind"],
  );
  for (const cls of ["companion", "flight_controller", "radio_module"]) {
    assert.ok(src.classes.templates.some((t) => t.class === cls && t.subtype === undefined), cls);
    assert.ok(src.classes.templates.some((t) => t.class === cls && t.subtype === "bare_media"), `${cls} bare_media`);
  }
});

test("списки Стоп-листа §8.1, §8.3, §8.4, §8.5 — с числом строк из таблицы §8; §8.2, §8.6, §8.7 — ожидаются файлами", () => {
  const expected = new Map(src.expectedStopLists.map((e) => [e.code, e.rows]));
  assert.equal(expected.size, 7);
  const present = new Map(src.stopLists.map((l) => [l.code, l.rows.length]));
  assert.deepEqual([...present.keys()].sort(), ["common_defaults", "wfb_default_keys", "zerotier", "zerotier_central_controllers"]);
  for (const [code, rows] of present) assert.equal(rows, expected.get(code), code);
  assert.equal([...expected.values()].reduce((a, b) => a + b, 0), 38_291);
});

test("у каждого элемента Код и Подпись; Коды типов — snake_case", () => {
  for (const t of [...src.types.objectTypes, ...src.types.linkTypes, ...src.types.indicatorTypes]) {
    assert.match(t.code, /^[a-z][a-z0-9_]*$/, t.code);
    assert.ok(t.label.length > 0, t.code);
  }
  const tz = src.enums.find((e) => e.code === "timezone")!;
  assert.ok(tz.values.some((v) => v.code === "Europe/Kyiv"));
  assert.equal(tz.aliases?.["Europe/Kiev"], "Europe/Kyiv");
});
