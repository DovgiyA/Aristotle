// Дымовой тест каркаса: пакет рабочего пространства npm импортируется по имени,
// и Node снимает типы без флагов (research R3; APP-28).
import { test } from "node:test";
import assert from "node:assert/strict";
import { message } from "@aristotel/protocol";

test("пакет @aristotel/protocol импортируется по имени и исполняется со снятием типов", () => {
  assert.equal(message("not_found", { id: "x" }), "Запись x не найдена.");
});
