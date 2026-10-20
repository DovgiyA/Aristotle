// T090 — дерево Материалов (research R4, R7, R10 фичи 006; BANK-10, BANK-14, STATION-30): каталоги до
// файла — 0750 на каждом уровне, файл и Заверения — 0440, повторное размещение дописывает недостающее,
// уборка снимает «только чтение» и убирает файл, все Заверения и недоставленную часть.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestationFilePath, incomingPath, materialFilePath, placeDelivered, removeFromTree } from "../../src/materials/tree.ts";

function dataDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const owner = { type: "case" as const, id: "01900000-0000-7000-8000-0000000000c1" };
const posix = process.platform !== "win32";

test("размещение: каталоги 0750 на каждом уровне, файл и Заверения 0440, .incoming 0700", (t) => {
  const dir = dataDir(t);
  writeFileSync(incomingPath(dir, "m1"), "v");
  placeDelivered(dir, "m1", owner, "a/b/x.img", ["{\"n\":1}\n", "{\"n\":2}\n"]);
  const file = materialFilePath(dir, owner, "a/b/x.img");
  assert.equal(readFileSync(file, "utf8"), "v");
  assert.equal(readFileSync(attestationFilePath(dir, owner, "a/b/x.img", 2), "utf8"), "{\"n\":2}\n");
  assert.equal(existsSync(incomingPath(dir, "m1")), false);
  if (posix) {
    assert.equal(statSync(file).mode & 0o777, 0o440);
    assert.equal(statSync(attestationFilePath(dir, owner, "a/b/x.img", 1)).mode & 0o777, 0o440);
    for (const level of ["a", "a/b"]) assert.equal(statSync(join(dir, "materials", "cases", owner.id, level)).mode & 0o777, 0o750, level);
    assert.equal(statSync(join(dir, "materials", ".incoming")).mode & 0o777, 0o700);
  }
});

test("повторное размещение дописывает недостающие Заверения и не трогает записанные", (t) => {
  const dir = dataDir(t);
  writeFileSync(incomingPath(dir, "m2"), "w");
  placeDelivered(dir, "m2", owner, "y.img", ["{\"n\":1}\n"]);
  placeDelivered(dir, "m2", owner, "y.img", ["{\"другое\":1}\n", "{\"n\":2}\n"]);
  assert.equal(readFileSync(attestationFilePath(dir, owner, "y.img", 1), "utf8"), "{\"n\":1}\n");
  assert.ok(existsSync(attestationFilePath(dir, owner, "y.img", 2)));
});

test("уборка: файл, все Заверения и недоставленная часть", (t) => {
  const dir = dataDir(t);
  writeFileSync(incomingPath(dir, "m3"), "x");
  placeDelivered(dir, "m3", owner, "z.img", ["1\n", "2\n"]);
  writeFileSync(incomingPath(dir, "m3"), "часть");
  removeFromTree(dir, "m3", owner, "z.img", 2);
  assert.equal(existsSync(materialFilePath(dir, owner, "z.img")), false);
  assert.equal(existsSync(attestationFilePath(dir, owner, "z.img", 1)), false);
  assert.equal(existsSync(attestationFilePath(dir, owner, "z.img", 2)), false);
  assert.equal(existsSync(incomingPath(dir, "m3")), false);
});
