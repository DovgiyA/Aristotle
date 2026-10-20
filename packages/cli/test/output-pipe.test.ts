// Читатель вывода закрыл канал раньше (`aristotel form … | head -6`): CLI не падает со стеком
// необработанного EPIPE, а доделывает команду и выходит с её кодом (APP-08). Найдено на Linux Mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, removeAtExit } from "../../../tests/support/harness.ts";

const SOURCE = join(import.meta.dirname, "..", "..", "..", "dictionary", "source");

test("stdout закрыт читателем до вывода — без стека EPIPE, команда доделана, код 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-epipe-"));
  removeAtExit(dir);
  const out = join(dir, "slovar-1.json");
  const child = spawn(process.execPath, [CLI_ENTRY, "dictionary", "build", "--source", SOURCE, "--out", out], { stdio: ["ignore", "pipe", "pipe"] });
  // Как `| head` после первых строк: читающий конец канала закрыт до того, как CLI начал писать.
  child.stdout.destroy();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
  assert.equal(stderr, "");
  assert.equal(code, 0);
  assert.ok(existsSync(out), "версия собрана");
});
