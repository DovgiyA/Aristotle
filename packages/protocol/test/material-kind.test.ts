// T005 — правила вида Материала по всем парам видов и владельцам (BANK-61, BANK-62, BANK-63, DICT-60;
// research R8 фичи 006; Clarifications — первичная постановка не требует Старшего).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MATERIAL_KINDS, kindChangeAction } from "../src/index.ts";

const HELD = ["image", "logical_copy"];

test("все пары видов и владельцев", () => {
  for (const owner of ["case", "document"] as const) {
    for (const from of [null, ...MATERIAL_KINDS]) {
      for (const to of MATERIAL_KINDS) {
        const r = kindChangeAction(from, to, owner);
        const where = `${owner}: ${from} → ${to}`;
        if (to === "legacy_file" || from === "legacy_file") assert.deepEqual(r, { error: "material_kind_converter_only" }, where);
        else if (to === "external_source" && owner === "case") assert.deepEqual(r, { error: "material_kind_owner" }, where);
        else if (from !== null && HELD.includes(from) && !HELD.includes(to)) assert.deepEqual(r, { action: "material.kind.release", warning: "material_starts_leaving" }, where);
        else assert.deepEqual(r, { action: "material.kind.set" }, where);
      }
    }
  }
});

test("первичная постановка, образ ⇄ логическая копия — material.kind.set", () => {
  assert.deepEqual(kindChangeAction(null, "image", "case"), { action: "material.kind.set" });
  assert.deepEqual(kindChangeAction("image", "logical_copy", "case"), { action: "material.kind.set" });
  assert.deepEqual(kindChangeAction("logical_copy", "image", "case"), { action: "material.kind.set" });
  assert.deepEqual(kindChangeAction("photo", "image", "case"), { action: "material.kind.set" });
});

test("неизвестный вид и вид не из применённой версии — material_kind_unknown (BANK-63)", () => {
  assert.deepEqual(kindChangeAction(null, "x", "case"), { error: "material_kind_unknown" });
  assert.deepEqual(kindChangeAction(null, "IMAGE", "case"), { error: "material_kind_unknown" });
  assert.deepEqual(kindChangeAction(null, "photo", "case", ["image"]), { error: "material_kind_unknown" });
  assert.deepEqual(kindChangeAction(null, "image", "case", ["image"]), { action: "material.kind.set" });
});
