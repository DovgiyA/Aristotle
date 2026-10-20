// Файл ключа под паролем — Ключ станции и Ключ Координатора — доступен только владельцу: на Linux и
// macOS — режим 0600, на Windows — ACL без наследования, одна запись владельца (data-model.md
// фичи 004 «station-key.age»; STATION-09, NET-14; конституция VI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATION_KEY_FORMAT, createKeyFile } from "../../src/keys/key-file.ts";

test("createKeyFile: файл ключа — только владельцу", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-key-acl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "station-key.age");
  const { privateKey } = generateKeyPairSync("ed25519");
  await createKeyFile(path, "test-password-x", { dataDir: dir, format: STATION_KEY_FORMAT, privateKey, workFactor: 10 });
  if (process.platform === "win32") {
    const acl = execFileSync("icacls", [path], { encoding: "utf8" });
    assert.doesNotMatch(acl, /\(I\)/, "унаследованных разрешений нет");
    const entries = acl.split(/\r?\n/).filter((line) => line.includes(":(") );
    assert.equal(entries.length, 1, acl);
  } else {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("createKeyFile зовёт restrictToOwner — как access-token и station.json", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../src/keys/key-file.ts", import.meta.url), "utf8");
  assert.match(source, /restrictToOwner\(path\)/);
});
