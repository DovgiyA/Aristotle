// T031 — имена полей типа Записи не начинаются с «$»: «$secret» в истории — метка, а не поле
// (research R2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { getRecordType, registerRecordType, unregisterRecordType } from "../../src/bank/record-types.ts";

test("тип с полем «$…» не регистрируется", () => {
  assert.throws(
    () =>
      registerRecordType({
        name: "test.dollar",
        fields: Type.Object({ $secret: Type.Optional(Type.Boolean()) }),
        indexText: () => "",
      }),
    /\$secret/,
  );
  assert.equal(getRecordType("test.dollar"), undefined);
});

test("тип с обычными полями регистрируется", () => {
  registerRecordType({ name: "test.plain", fields: Type.Object({ x: Type.Optional(Type.String()) }), indexText: () => "" });
  assert.notEqual(getRecordType("test.plain"), undefined);
  unregisterRecordType("test.plain");
});
