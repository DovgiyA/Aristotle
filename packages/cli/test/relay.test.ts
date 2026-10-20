// T029 фичи 004 — CLI Ретранслятора: init --role relay с отпечатком, tls show|renew, registry export
// на Опорной станции и relay registry import на Ретрансляторе, serve в роли relay (contracts/cli.md;
// RELAY-16, RELAY-19, RELAY-24).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { serializeSignedDocument, spkiFingerprint } from "@aristotel/protocol";
import { emptyDataDir, freePort, registryDocument, runCli, signDocument, spawnCli } from "../../../tests/support/harness.ts";
import { startNetwork } from "../../../tests/support/network.ts";

test("init --role relay: печатает отпечаток TLS; tls show — тот же, tls renew — отпечаток прежний", async (t) => {
  const dir = emptyDataDir(t);
  const port = await freePort();
  const init = await runCli(["init", "--role", "relay", "--group", "A", "--url", `https://127.0.0.1:${port}`, "--listen", `127.0.0.1:${port}`, "--data-dir", dir, "--json"]);
  assert.equal(init.code, 0, init.stderr);
  const created = JSON.parse(init.stdout);
  assert.equal(created.tlsSpki, spkiFingerprint(readFileSync(join(dir, "tls-cert.pem"), "utf8")));
  const show = JSON.parse((await runCli(["tls", "show", "--data-dir", dir, "--json"])).stdout);
  assert.equal(show.tlsSpki, created.tlsSpki);
  assert.match(show.groups, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  const before = readFileSync(join(dir, "tls-cert.pem"), "utf8");
  const renew = JSON.parse((await runCli(["tls", "renew", "--data-dir", dir, "--json"])).stdout);
  assert.equal(renew.tlsSpki, created.tlsSpki);
  assert.notEqual(readFileSync(join(dir, "tls-cert.pem"), "utf8"), before);
  const table = await runCli(["tls", "show", "--data-dir", dir]);
  assert.match(table.stdout, /Для сверки голосом/);
});

test("init --role relay: без --group или --url, неверный Код или адрес — отказ, файлов нет", async (t) => {
  for (const extra of [[], ["--group", "a1", "--url", "https://x.test"], ["--group", "A", "--url", "http://x.test"], ["--group", "A"]]) {
    const dir = emptyDataDir(t);
    const res = await runCli(["init", "--role", "relay", ...extra, "--data-dir", dir]);
    assert.equal(res.code, 1, extra.join(" "));
  }
});

test("registry export на Опорной станции и relay registry import на Ретрансляторе (RELAY-19)", async (t) => {
  const net = await startNetwork(t, { relays: 1, startRelays: false });
  const out = join(emptyDataDir(t), "reestr-1.json");
  const exported = await runCli(["registry", "export", "--out", out, "--data-dir", net.dir, "--json"]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).number, 1);
  // Новый Ретранслятор, которого нет в экспортированной версии, — отказ «нет в записи».
  const dir = emptyDataDir(t);
  const port = await freePort();
  await runCli(["init", "--role", "relay", "--group", "A", "--url", `https://127.0.0.1:${port}`, "--data-dir", dir]);
  const notListed = await runCli(["relay", "registry", "import", out, "--data-dir", dir]);
  assert.equal(notListed.code, 1);
  assert.match(notListed.stderr, /нет в записи/);
  // Версия, где этот Ретранслятор есть, — принимается; повтор — отказ.
  const tlsSpki = JSON.parse((await runCli(["tls", "show", "--data-dir", dir, "--json"])).stdout).tlsSpki;
  const v1 = signDocument(registryDocument(net.server.db, { relays: [{ url: `https://127.0.0.1:${port}`, tlsSpki }], coordinatorKeys: [net.coordinatorKey.publicKey] }), net.coordinatorKey);
  const file = join(emptyDataDir(t), "v1.json");
  (await import("node:fs")).writeFileSync(file, serializeSignedDocument(v1));
  const ok = await runCli(["relay", "registry", "import", file, "--data-dir", dir, "--json"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).number, 1);
  assert.equal((await runCli(["relay", "registry", "import", file, "--data-dir", dir])).code, 1);
  const status = JSON.parse((await runCli(["status", "--data-dir", dir, "--json"])).stdout);
  assert.equal(status.registryNumber, 1);
  assert.equal(status.tlsSpki, tlsSpki);
});

test("serve в роли relay: «слушает», остановка по SIGTERM; tls в роли station — отказ", async (t) => {
  const dir = emptyDataDir(t);
  const port = await freePort();
  await runCli(["init", "--role", "relay", "--group", "A", "--url", `https://127.0.0.1:${port}`, "--listen", `127.0.0.1:${port}`, "--data-dir", dir]);
  const relay = await spawnCli(t, ["serve", "--data-dir", dir], /слушает/);
  await relay.stop();
  const station = emptyDataDir(t);
  await runCli(["init", "--role", "station", "--data-dir", station]);
  const refused = await runCli(["tls", "show", "--data-dir", station]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /не для роли station/);
});
