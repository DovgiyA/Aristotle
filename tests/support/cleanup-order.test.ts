// Каталог стенда живёт, пока работают хуки t.after, зарегистрированные позже него: они закрывают службы,
// а на Windows открытый bank.sqlite удалить нельзя — EPERM (прогон на Windows 10, 2026-10-17 и -18).
// Хуки node:test идут в порядке регистрации, поэтому каталоги удаляются в конце процесса файла теста.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { prepareDataDir } from "./harness.ts";
import { tempDir } from "./network.ts";

test("каталоги стенда на месте во время хуков, зарегистрированных позже", async (t) => {
  const data = await prepareDataDir(t);
  const plain = tempDir(t);
  t.after(() => {
    assert.equal(existsSync(data.dir), true, "каталог данных удалён раньше, чем закрыта служба");
    assert.equal(existsSync(plain), true, "временный каталог удалён раньше хука");
  });
});
