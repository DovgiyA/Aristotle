// T025 фичи 003 — aristotel coordinator-key create|show без установки и без службы: файл age под
// паролем, права 0600, отпечаток; неверный пароль — отказ; каталог данных — отказ; файл не
// перезаписывается; пароль короче 12 знаков — отказ. Единственный тест, где scrypt идёт с множителем 18
// (NET-14, NET-40, NET-42; research R6, R14; contracts/cli.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeKey, keyFingerprint } from "@aristotel/protocol";
import { writeInstall } from "@aristotel/core";
import { emptyDataDir, runCli } from "../../../tests/support/harness.ts";

function passwordFile(dir: string, password: string): string {
  const path = join(dir, `password-${password.length}.txt`);
  writeFileSync(path, `${password}\n`, { mode: 0o600 });
  return path;
}

test("create и show без установки и без службы; неверный пароль — отказ", async (t) => {
  const usb = emptyDataDir(t);
  const dataDir = emptyDataDir(t);
  const out = join(usb, "c1.key");
  const good = passwordFile(usb, "test-password-x");
  const created = await runCli(["coordinator-key", "create", "--out", out, "--password-file", good, "--data-dir", dataDir, "--json"]);
  assert.equal(created.code, 0, created.stderr);
  const info = JSON.parse(created.stdout) as { publicKey: string; keyFingerprint: string };
  assert.equal(decodeKey(info.publicKey)?.length, 32);
  assert.equal(info.keyFingerprint, keyFingerprint(info.publicKey));
  const text = readFileSync(out, "utf8");
  assert.match(text, /^-----BEGIN AGE ENCRYPTED FILE-----/);
  assert.ok(!text.includes(info.publicKey), "открытый ключ — внутри шифрованного файла");
  if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);

  const shown = await runCli(["coordinator-key", "show", out, "--password-file", good, "--data-dir", dataDir, "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), info);

  const wrong = await runCli(["coordinator-key", "show", out, "--password-file", passwordFile(usb, "test-password-y!"), "--data-dir", dataDir]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Неверный пароль Ключа Координатора/);

  // Повторный create в тот же путь — отказ, файл не изменён.
  const again = await runCli(["coordinator-key", "create", "--out", out, "--password-file", good, "--data-dir", dataDir]);
  assert.equal(again.code, 1);
  assert.equal(readFileSync(out, "utf8"), text);
  // Каталог данных не создан: команде не нужна установка.
  assert.equal(existsSync(join(dataDir, "install.json")), false);
});

test("create в каталог данных Опорной станции — отказ, файла нет (NET-14)", async (t) => {
  const dataDir = emptyDataDir(t);
  writeInstall(dataDir, { role: "base-station" });
  const usb = emptyDataDir(t);
  const pw = passwordFile(usb, "test-password-x");
  const nested = join(dataDir, "keys");
  mkdirSync(nested);
  const elsewhere = emptyDataDir(t);
  for (const [out, flags] of [
    [join(dataDir, "c1.key"), ["--data-dir", dataDir]],
    [join(nested, "c1.key"), ["--data-dir", dataDir]],
    // Каталог данных не назван, но выше по дереву лежит install.json роли base-station.
    [join(nested, "c2.key"), ["--data-dir", elsewhere]],
  ] as const) {
    const res = await runCli(["coordinator-key", "create", "--out", out, "--password-file", pw, ...flags]);
    assert.equal(res.code, 1, out);
    assert.match(res.stderr, /каталоге данных Опорной станции/);
    assert.equal(existsSync(out), false);
  }
});

test("пароль короче 12 знаков — отказ; пароля в аргументах нет", async (t) => {
  const usb = emptyDataDir(t);
  const out = join(usb, "c1.key");
  const short = await runCli(["coordinator-key", "create", "--out", out, "--password-file", passwordFile(usb, "short-pw"), "--data-dir", emptyDataDir(t)]);
  assert.equal(short.code, 1);
  assert.match(short.stderr, /не короче 12 знаков/);
  assert.equal(existsSync(out), false);
  const inline = await runCli(["coordinator-key", "create", "--out", out, "--password", "test-password-x", "--data-dir", emptyDataDir(t)]);
  assert.equal(inline.code, 1);
  assert.equal(existsSync(out), false);
});

// T062 фичи 003 — каталога для --out нет: понятный отказ до пароля и scrypt, файл не создаётся
// (research R6; contracts/cli.md «coordinator-key create»).
test("create в несуществующий каталог — отказ до пароля, код 1", async (t) => {
  const usb = emptyDataDir(t);
  const out = join(usb, "no-such-dir", "c1.key");
  // Файла пароля нет: если бы пароль читался раньше проверки каталога, отказ был бы другим.
  const res = await runCli(["coordinator-key", "create", "--out", out, "--password-file", join(usb, "missing.txt"), "--data-dir", emptyDataDir(t)]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Каталога для файла Ключа Координатора нет/);
  assert.doesNotMatch(res.stderr, /ENOENT/);
  assert.equal(existsSync(out), false);
});

// T065 фичи 003 — в диагностиках нет путей к файлам ключей (research R15, SC-002).
test("испорченный файл ключа и повторный create — отказ без пути к файлу", async (t) => {
  const usb = emptyDataDir(t);
  const pw = passwordFile(usb, "test-password-x");
  const broken = join(usb, "broken-c1.key");
  writeFileSync(broken, "не ключ", { mode: 0o600 });
  const shown = await runCli(["coordinator-key", "show", broken, "--password-file", pw, "--data-dir", emptyDataDir(t)]);
  assert.equal(shown.code, 1);
  assert.match(shown.stderr, /не Ключ Координатора или испорчен/);
  const created = await runCli(["coordinator-key", "create", "--out", broken, "--password-file", pw, "--data-dir", emptyDataDir(t)]);
  assert.equal(created.code, 1);
  assert.match(created.stderr, /уже есть/);
  for (const res of [shown, created]) {
    assert.equal((res.stdout + res.stderr).includes(broken), false);
    assert.equal((res.stdout + res.stderr).includes("broken-c1.key"), false);
  }
});
