// T036 фичи 003 — сценарий 19, шаг 19.13: Запуск Сети через CLI — Ключ Координатора, регистрация,
// отпечаток Ретранслятора, черновик, подпись без службы, применение, Реестр читает Н1; черновик без
// Ретранслятора — отказ (NET-16, NET-17, NET-04, NET-05; spec.md US3, сценарии 1–3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readAccessToken } from "@aristotel/core";
import { keyFingerprint } from "@aristotel/protocol";
import {
  RELAY_X,
  maintenanceRequest,
  emptyDataDir,
  freePort,
  runCli,
  spawnService,
  writeCoordinatorKeyFile,
  writePasswordFile,
} from "../../support/harness.ts";

const RELAY_PEM = join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test", "vectors", "relay-x.pem");

test("19.13: Реестр версии 1 со своей записью, Ключом Координатора и Ретранслятором", async (t) => {
  const dir = emptyDataDir(t);
  const port = await freePort();
  const init = await runCli(["init", "--role", "base-station", "--senior-label", "С1", "--port", String(port), "--data-dir", dir, "--json"]);
  assert.equal(init.code, 0, init.stderr);
  const { memberId: c1 } = JSON.parse(init.stdout) as { memberId: string };
  const service = await spawnService(t, dir);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", dir]);
  const usb = emptyDataDir(t);
  const key = join(usb, "c1.key");
  const publicKey = await writeCoordinatorKeyFile(key, dir);
  const pw = writePasswordFile(join(usb, "pw.txt"));

  const registered = await cli("coordinator-key", "register", key, "--password-file", pw, "--json");
  assert.equal(registered.code, 0, registered.stderr);

  const spki = await runCli(["registry", "relay-spki", RELAY_PEM, "--json"]);
  assert.equal(spki.code, 0, spki.stderr);
  assert.equal((JSON.parse(spki.stdout) as { tlsSpki: string }).tlsSpki, RELAY_X.tlsSpki);

  const noRelay = await cli("registry", "draft", "--code", "A", "--out", join(usb, "none.json"));
  assert.equal(noRelay.code, 1);
  assert.match(noRelay.stderr, /хотя бы один Ретранслятор/);

  const draftPath = join(usb, "v1.draft.json");
  const draft = await cli("registry", "draft", "--code", "A", "--add-relay", `${RELAY_X.url}=${RELAY_X.tlsSpki}`, "--out", draftPath);
  assert.equal(draft.code, 0, draft.stderr);
  const signedPath = join(usb, "v1.json");
  const signed = await runCli(["registry", "sign", draftPath, "--key", key, "--password-file", pw, "--out", signedPath, "--yes"]);
  assert.equal(signed.code, 0, signed.stderr);
  const applied = await cli("registry", "apply", signedPath);
  assert.equal(applied.code, 0, applied.stderr);

  const { id: n1 } = (await maintenanceRequest({ dir, port, token: readAccessToken(dir), seniorId: c1 }, "POST", "/api/test/members", { label: "Н1", role: "observer" }))
    .body as { id: string };
  const shown = await cli("registry", "show", "--as", n1, "--json");
  assert.equal(shown.code, 0, shown.stderr);
  const current = (JSON.parse(shown.stdout) as { current: { number: number; body: { coordinatingGroup: string; coordinatorKeys: string[]; groups: { code: string; relays: unknown[] }[] }; coordinatorKeyFingerprints: string[] } }).current;
  assert.equal(current.number, 1);
  assert.equal(current.body.coordinatingGroup, "A");
  assert.deepEqual(current.body.coordinatorKeys, [publicKey]);
  assert.deepEqual(current.coordinatorKeyFingerprints, [keyFingerprint(publicKey)]);
  assert.deepEqual(current.body.groups.map((g) => [g.code, g.relays]), [["A", [RELAY_X]]]);
  const table = await cli("registry", "show", "--as", n1);
  assert.match(table.stdout, new RegExp(keyFingerprint(publicKey)));
  assert.match(table.stdout, /relay-x\.test:8443/);
  await service.stop();
});
