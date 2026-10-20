// T028 — aristotel init: роль задаётся при установке; Станция и Ретранслятор — только install.json
// (APP-01, BANK-02; US1 сценарии 3–4).
// Журнал в проверках — записи Членов Группы: служба пишет group-key.create при запуске (фича 003, T015).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, openBank, openDatabase, writeInstall } from "@aristotel/core";
import { emptyDataDir, freePort, runCli } from "../../../tests/support/harness.ts";

test("повторный init — код 1, «Роль задаётся при установке», файлы не меняются", async (t) => {
  const dir = emptyDataDir(t);
  const port = String(await freePort());
  const first = await runCli(["init", "--role", "base-station", "--senior-label", "С1", "--port", port, "--data-dir", dir]);
  assert.equal(first.code, 0, first.stderr);
  const before = readFileSync(join(dir, "install.json"), "utf8");
  const second = await runCli(["init", "--role", "relay", "--port", port, "--data-dir", dir]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /Роль задаётся при установке/);
  assert.equal(readFileSync(join(dir, "install.json"), "utf8"), before);
});

test("init --role station: только install.json и токен, без bank.sqlite (BANK-02)", async (t) => {
  const dir = emptyDataDir(t);
  const init = await runCli(["init", "--role", "station", "--data-dir", dir]);
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(readdirSync(dir).sort(), ["access-token", "install.json"]);
  assert.equal(existsSync(join(dir, "bank.sqlite")), false);
});

// Роль relay — фича 004 (T036): install.json, токен и TLS-ключ с сертификатом, Банка нет (BANK-02).
test("init --role relay: install.json, токен и TLS-ключ, без bank.sqlite (BANK-02)", async (t) => {
  const dir = emptyDataDir(t);
  const init = await runCli(["init", "--role", "relay", "--group", "A", "--url", "https://relay-x.test:8443", "--data-dir", dir]);
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(readdirSync(dir).sort(), ["access-token", "install.json", "tls-cert.pem", "tls-key.pem"]);
  assert.equal(existsSync(join(dir, "bank.sqlite")), false);
});

test("base-station без --senior-label — код 1, ничего не создано", async (t) => {
  const dir = emptyDataDir(t);
  const init = await runCli(["init", "--role", "base-station", "--data-dir", dir]);
  assert.equal(init.code, 1);
  assert.match(init.stderr, /--senior-label/);
  assert.deepEqual(readdirSync(dir), []);
});

test("неизвестная роль — код 1", async (t) => {
  const dir = emptyDataDir(t);
  const init = await runCli(["init", "--role", "x", "--data-dir", dir]);
  assert.equal(init.code, 1);
  assert.match(init.stderr, /Неизвестная роль/);
});

// T062 — init, прерванный после записи install.json, доводится повтором (FR-003, ROLE-26, US1/AC2).
for (const stage of ["только install.json", "install.json и пустой Банк"] as const) {
  test(`повторный init после сбоя (${stage}) заводит первого Старшего`, async (t) => {
    const dir = emptyDataDir(t);
    const port = await freePort();
    // Состояние, в котором init прервался до заведения первого Старшего.
    const install = writeInstall(dir, { role: "base-station", port });
    if (stage === "install.json и пустой Банк") closeDatabase(openBank(dir, install));

    const again = await runCli(["init", "--role", "base-station", "--senior-label", "С1", "--port", String(port), "--data-dir", dir, "--json"]);
    assert.equal(again.code, 0, again.stderr);
    const { memberId, installId } = JSON.parse(again.stdout) as { memberId: string; installId: string };
    assert.equal(installId, install.installId);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "cli.json"), "utf8")), { memberId });

    // Третий init — отказ: первый Старший уже заведён.
    const third = await runCli(["init", "--role", "base-station", "--senior-label", "С2", "--data-dir", dir]);
    assert.equal(third.code, 1);
    assert.match(third.stderr, /Роль задаётся при установке/);
  });
}

test("повторный init с другой ролью после сбоя — отказ (APP-01)", async (t) => {
  const dir = emptyDataDir(t);
  writeInstall(dir, { role: "base-station", port: await freePort() });
  const other = await runCli(["init", "--role", "relay", "--data-dir", dir]);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /Роль задаётся при установке/);
});

// T063 — два одновременных init в один каталог данных: успешен ровно один, первый Старший один
// (spec Edge Cases «два первых Старших», ROLE-26).
test("два одновременных init — успешен ровно один, первый Старший заведён один раз", async (t) => {
  for (let round = 0; round < 10; round++) {
    const dir = emptyDataDir(t);
    const port = String(await freePort());
    const [a, b] = await Promise.all([
      runCli(["init", "--role", "base-station", "--senior-label", "С1", "--port", port, "--data-dir", dir]),
      runCli(["init", "--role", "base-station", "--senior-label", "С2", "--port", port, "--data-dir", dir]),
    ]);
    assert.deepEqual([a.code, b.code].sort(), [0, 1], `раунд ${round}: ${a.stderr} | ${b.stderr}`);
    const failed = a.code === 1 ? a : b;
    assert.match(failed.stderr, /Роль задаётся при установке/, `раунд ${round}`);
    const db = openDatabase(join(dir, "bank.sqlite"));
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM member").get()?.["n"], 1, `раунд ${round}`);
      assert.equal(db.prepare("SELECT count(*) AS n FROM journal WHERE actorId IS NOT NULL").get()?.["n"], 1, `раунд ${round}`);
    } finally {
      db.close();
    }
  }
});
