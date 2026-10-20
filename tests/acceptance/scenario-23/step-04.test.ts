// T027 фичи 003 — сценарий 23, шаг 23.4: Ключи Координатора лежат у Старших вне Опорной станции — ни
// файлы каталога данных, ни БД, ни журнал, ни логи службы не содержат их секретных частей; завести
// ключ в каталоге данных нельзя (NET-14; spec.md US2, сценарии 2, 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyFile, readKeyFile } from "../../../packages/cli/src/key-file.ts";
import { coordinatorKeyProofMessage } from "@aristotel/protocol";
import { callAs, emptyDataDir, groupA, runCli, startTestService } from "../../support/harness.ts";

test("23.4: Ключи Координатора С1 и С2 — не на Опорной станции", async (t) => {
  const log: string[] = [];
  const svc = await startTestService(t, { logStream: { write: (line) => void log.push(line) } });
  const a = groupA(svc.db, svc.seniorId);
  const usb = emptyDataDir(t);
  const secrets: string[] = [];
  for (const [who, name] of [[a.c1, "c1.key"], [a.c2 as string, "c2.key"]] as const) {
    const path = join(usb, name);
    await createKeyFile(path, "test-password-x", { dataDir: svc.dir, workFactor: 10 });
    const key = await readKeyFile(path, "test-password-x");
    secrets.push(key.pkcs8, Buffer.from(key.pkcs8, "base64").toString("hex"));
    const proof = Buffer.from(key.sign(coordinatorKeyProofMessage(svc.install.installId, who))).toString("base64").replace(/=+$/, "");
    const res = await callAs(svc, who, "POST", "/api/coordinator-keys", { publicKey: key.publicKey, proof });
    assert.equal(res.statusCode, 201, res.body);
  }
  await callAs(svc, a.c1, "GET", "/api/journal");
  await callAs(svc, a.c1, "GET", "/api/coordinator-keys");

  const haystack = [
    ...readdirSync(svc.dir).map((name) => readFileSync(join(svc.dir, name))),
    Buffer.from(JSON.stringify(svc.db.prepare("SELECT * FROM journal").all())),
    Buffer.from(log.join("")),
  ];
  for (const bytes of haystack) {
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false);
  }

  // Завести ключ в каталоге данных — отказ (CLI, без службы).
  const pw = join(usb, "pw.txt");
  writeFileSync(pw, "test-password-x\n", { mode: 0o600 });
  const out = join(svc.dir, "c3.key");
  const res = await runCli(["coordinator-key", "create", "--out", out, "--password-file", pw, "--data-dir", svc.dir]);
  assert.equal(res.code, 1);
  assert.equal(existsSync(out), false);
});
