// T004 — правила относительного пути Материала (BANK-10, BANK-11; research R4, R7 фичи 006).
import { test } from "node:test";
import assert from "node:assert/strict";
import { attestationFileName, checkMaterialPath } from "../src/index.ts";

test("допустимые пути и ключ уникальности — NFC и нижний регистр", () => {
  for (const p of ["x.img", "nositel/obraz.img", "носитель/образ.img", "a/b/c/d.e.f", "x.zaverenie.json", "x.zaverenie-1.json.txt"]) {
    const r = checkMaterialPath(p);
    assert.ok(r.ok, p);
  }
  const a = checkMaterialPath("X.IMG");
  const b = checkMaterialPath("x.img");
  assert.ok(a.ok && b.ok && a.pathKey === b.pathKey);
});

test("отказы с правилом", () => {
  const cases: [string, string][] = [
    ["", "empty"],
    ["/abs", "absolute"],
    ["C:\\x", "forbidden_char"],
    ["a\\b", "forbidden_char"],
    ["a:b", "forbidden_char"],
    ["a/../b", "dot_segment"],
    ["./a", "dot_segment"],
    ["..", "dot_segment"],
    ["a//b", "empty_segment"],
    ["a/", "empty_segment"],
    ["a\u0000b", "control_char"],
    ["a\u0007b", "control_char"],
    ["a. ", "trailing_dot_or_space"],
    ["a.", "trailing_dot_or_space"],
    ["CON", "reserved_name"],
    ["dir/nul.txt", "reserved_name"],
    ["COM1", "reserved_name"],
    ["x".repeat(256), "segment_too_long"],
    ["я".repeat(128), "segment_too_long"],
    [Array.from({ length: 33 }, () => "a").join("/"), "too_many_segments"],
    ["e\u0301.img", "not_nfc"],
    ["a\ud800", "not_well_formed"],
  ];
  for (const [path, rule] of cases) {
    const r = checkMaterialPath(path);
    assert.ok(!r.ok && r.code === "material_path_invalid" && r.rule === rule, `${JSON.stringify(path)} → ${JSON.stringify(r)}`);
  }
});

test("служебный суффикс файла Заверения зарезервирован (research R7)", () => {
  for (const p of ["x.img.zaverenie-1.json", "a/b.zaverenie-12.json", "X.ZAVERENIE-3.JSON", "x.zaverenie-1.json/y"]) {
    const r = checkMaterialPath(p);
    assert.ok(!r.ok && r.code === "material_path_reserved", p);
  }
  assert.equal(attestationFileName("a/x.img", 2), "a/x.img.zaverenie-2.json");
  assert.equal(checkMaterialPath(attestationFileName("a/x.img", 2)).ok, false);
});
