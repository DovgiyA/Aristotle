// T039 фичи 003 — aristotel registry по contracts/cli.md: relay-spki и sign без установки и без
// службы; сводка и подтверждение у sign; чужой формат — отказ; --out не перезаписывается; отказы
// apply — по reason по-русски, код 1; show --document — документ как есть (research R6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY_FORMAT, bodySha256, keyFingerprint, parseSignedDocument, verifySignature } from "@aristotel/protocol";
import { readAccessToken } from "@aristotel/core";
import { RELAY_X, emptyDataDir, freePort, runCli, spawnService, writeCoordinatorKeyFile, writePasswordFile } from "../../../tests/support/harness.ts";

const VECTORS = join(import.meta.dirname, "..", "..", "protocol", "test", "vectors");
const RELAY_PEM = join(VECTORS, "relay-x.pem");
/** Строка получателя age с верной контрольной суммой — из векторов контракта. */
const RECIPIENT = (JSON.parse(JSON.parse(readFileSync(join(VECTORS, "reestr-v1.json"), "utf8")).body) as { groups: { encryptionKey: string }[] }).groups[0]!.encryptionKey;

test("relay-spki и sign — без установки и без службы; сводка, подтверждение, --out без перезаписи", async (t) => {
  const nowhere = emptyDataDir(t);
  const spki = await runCli(["registry", "relay-spki", RELAY_PEM, "--data-dir", nowhere]);
  assert.equal(spki.code, 0, spki.stderr);
  assert.equal(spki.stdout.trim(), RELAY_X.tlsSpki);

  const usb = emptyDataDir(t);
  const key = join(usb, "c1.key");
  const publicKey = await writeCoordinatorKeyFile(key, nowhere);
  const pw = writePasswordFile(join(usb, "pw.txt"));
  const body = JSON.stringify({
    number: 1,
    issuedAt: "2026-10-17T10:00:00.000Z",
    coordinatingGroup: "A",
    coordinatorKeys: [publicKey],
    groups: [{ code: "A", signingKey: publicKey, encryptionKey: RECIPIENT, state: "active", relays: [RELAY_X] }],
  });
  const draft = join(usb, "draft.json");
  writeFileSync(draft, JSON.stringify({ format: REGISTRY_FORMAT, body, signatures: [] }));

  // Без --yes и без терминала — отказ: подтверждение обязательно.
  const unconfirmed = await runCli(["registry", "sign", draft, "--key", key, "--password-file", pw, "--out", join(usb, "x.json"), "--data-dir", nowhere]);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.stderr, /--yes/);
  assert.match(unconfirmed.stdout, /relay-x\.test:8443/);
  assert.match(unconfirmed.stdout, new RegExp(keyFingerprint(publicKey)));
  assert.equal(existsSync(join(usb, "x.json")), false);

  const out = join(usb, "v1.json");
  const signed = await runCli(["registry", "sign", draft, "--key", key, "--password-file", pw, "--out", out, "--yes", "--data-dir", nowhere]);
  assert.equal(signed.code, 0, signed.stderr);
  const doc = parseSignedDocument(readFileSync(out, "utf8"), REGISTRY_FORMAT);
  assert.equal(doc.body, body);
  assert.ok(verifySignature(doc, publicKey));
  assert.equal(existsSync(join(nowhere, "install.json")), false);

  const again = await runCli(["registry", "sign", draft, "--key", key, "--password-file", pw, "--out", out, "--yes"]);
  assert.equal(again.code, 1);

  // T068 — --json: stdout разбирается как JSON, сводка для подтверждения — в stderr.
  const jsonOut = join(usb, "v1-json.json");
  const asJson = await runCli(["registry", "sign", draft, "--key", key, "--password-file", pw, "--out", jsonOut, "--yes", "--json"]);
  assert.equal(asJson.code, 0, asJson.stderr);
  const result = JSON.parse(asJson.stdout) as { number: number; bodySha256: string; keyFingerprint: string; out: string };
  assert.deepEqual(result, { number: 1, bodySha256: bodySha256(body), keyFingerprint: keyFingerprint(publicKey), out: jsonOut });
  assert.match(asJson.stderr, /relay-x\.test:8443/);

  const alien = join(usb, "alien.json");
  writeFileSync(alien, JSON.stringify({ format: "aristotel/slovar/v1", body, signatures: [] }));
  const wrongFormat = await runCli(["registry", "sign", alien, "--key", key, "--password-file", pw, "--out", join(usb, "y.json"), "--yes"]);
  assert.equal(wrongFormat.code, 1);
  assert.match(wrongFormat.stderr, /aristotel\/reestr\/v1/);
});

test("apply — отказ по reason по-русски; show --document — документ как есть", async (t) => {
  const dir = emptyDataDir(t);
  const port = await freePort();
  const init = await runCli(["init", "--role", "base-station", "--senior-label", "С1", "--port", String(port), "--data-dir", dir, "--json"]);
  assert.equal(init.code, 0, init.stderr);
  const service = await spawnService(t, dir);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", dir]);
  const usb = emptyDataDir(t);
  const key = join(usb, "c1.key");
  await writeCoordinatorKeyFile(key, dir);
  const pw = writePasswordFile(join(usb, "pw.txt"));
  assert.equal((await cli("coordinator-key", "register", key, "--password-file", pw)).code, 0);

  const draft = join(usb, "v1.draft.json");
  assert.equal((await cli("registry", "draft", "--code", "A", "--add-relay", `${RELAY_X.url}=${RELAY_X.tlsSpki}`, "--out", draft)).code, 0);
  const unsigned = await cli("registry", "apply", draft);
  assert.equal(unsigned.code, 1);
  assert.match(unsigned.stderr, /версия не подписана/);

  const out = join(usb, "v1.json");
  assert.equal((await runCli(["registry", "sign", draft, "--key", key, "--password-file", pw, "--out", out, "--yes"])).code, 0);
  assert.equal((await cli("registry", "apply", out)).code, 0);
  const document = await cli("registry", "show", "--document");
  assert.equal(document.code, 0, document.stderr);
  const stored = (await fetch(`http://127.0.0.1:${port}/api/registry/versions/1`, {
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${readAccessToken(dir)}`, "aristotel-member": JSON.parse(init.stdout).memberId },
  }).then((r) => r.text()));
  assert.equal(document.stdout, stored);
  const byNumber = await cli("registry", "show", "--number", "1", "--json");
  assert.equal((JSON.parse(byNumber.stdout) as { number: number }).number, 1);
  await service.stop();
});
