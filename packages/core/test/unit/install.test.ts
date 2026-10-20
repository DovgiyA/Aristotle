// T012 — установка: роль задаётся один раз, токен доступа, сверка с Банком (APP-01; research R11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeInstall,
  readInstall,
  readAccessToken,
  checkBankMatchesInstall,
  InstallError,
} from "../../src/install/install.ts";
import { openDatabase } from "../../src/db/open.ts";
import { removeAtExit } from "../../../../tests/support/harness.ts";
import { migrate } from "../../src/db/migrations.ts";

// Каталог удаляется при выходе процесса теста — после хуков, закрывающих БД (EPERM на Windows).
function tempDir(_t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-install-"));
  removeAtExit(dir);
  return dir;
}

test("install.json пишется один раз; повторная запись — отказ role_already_set (APP-01)", (t) => {
  const dir = tempDir(t);
  const install = writeInstall(dir, { role: "base-station" });
  assert.equal(install.role, "base-station");
  assert.deepEqual(install.apiVersions, [1]);
  assert.equal(install.port, 47100);
  assert.match(install.installId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  const before = readFileSync(join(dir, "install.json"), "utf8");
  assert.throws(
    () => writeInstall(dir, { role: "relay" }),
    (e: unknown) => e instanceof InstallError && e.code === "role_already_set",
  );
  assert.equal(readFileSync(join(dir, "install.json"), "utf8"), before);
  assert.deepEqual(readInstall(dir), install);
});

test("роль — только base-station, station или relay", (t) => {
  const dir = tempDir(t);
  assert.throws(
    () => writeInstall(dir, { role: "x" as never }),
    (e: unknown) => e instanceof InstallError && e.code === "role_unknown",
  );
});

test("access-token — 32 случайных байта в base64url, доступен только владельцу (research R11)", (t) => {
  const dir = tempDir(t);
  writeInstall(dir, { role: "base-station" });
  const token = readAccessToken(dir);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, "access-token")).mode & 0o777, 0o600);
  } else {
    t.diagnostic("на Windows права задаёт ACL владельца (icacls); проверяется в CI на windows-latest");
  }
});

test("служба не стартует, если роль или installId в meta не совпадают с install.json", (t) => {
  const dir = tempDir(t);
  const install = writeInstall(dir, { role: "base-station" });
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => db.close());
  migrate(db, install);
  checkBankMatchesInstall(db, install);
  assert.throws(
    () => checkBankMatchesInstall(db, { ...install, installId: "y" }),
    (e: unknown) => e instanceof InstallError && e.code === "install_mismatch",
  );
});
