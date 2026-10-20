// T054 — CLI и несовместимая версия API: код выхода 3, поддерживаемые версии и предложение
// обновиться; aristotel --version (APP-23; US5 сценарии 1–2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeInstall } from "@aristotel/core";
import { API_VERSIONS, PROGRAM_VERSION } from "@aristotel/protocol";
import { emptyDataDir, freePort, runCli } from "../../../tests/support/harness.ts";

test("служба другой версии отвечает 426 — CLI выходит с кодом 3 и предлагает обновиться", async (t) => {
  // Опорная станция, которая поддерживает только версию API 2.
  const port = await freePort();
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "api_version_incompatible", supported: [2], message: "текст службы" }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = emptyDataDir(t);
  writeInstall(dir, { role: "base-station", port });

  const result = await runCli(["journal", "--data-dir", dir]);
  assert.equal(requests, 1);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /поддерживает: 2/);
  assert.match(result.stderr, new RegExp(`версию API этой программы \\(${API_VERSIONS.join(", ")}\\)`));
  assert.match(result.stderr, /Обновите программу/);
  assert.equal(result.stdout, "");
});

test("aristotel --version — версия программы и поддерживаемые версии API", async () => {
  const result = await runCli(["--version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`aristotel ${PROGRAM_VERSION.replaceAll(".", "\\.")}`));
  assert.match(result.stdout, new RegExp(`API: ${API_VERSIONS.join(", ")}`));
});

// T066 фичи 003 — документ версии Реестра читается тем же клиентом: на 426 — то же объяснение и код 3,
// а не текст несовместимой службы (APP-23).
test("registry show --number 1 --document против службы с 426 — объяснение и код 3", async (t) => {
  const port = await freePort();
  const server = createServer((req, res) => {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "api_version_incompatible", supported: [2], message: "текст службы" }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = emptyDataDir(t);
  writeInstall(dir, { role: "base-station", port });
  const result = await runCli(["registry", "show", "--number", "1", "--document", "--data-dir", dir]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /поддерживает: 2/);
  assert.match(result.stderr, /Обновите программу/);
  assert.doesNotMatch(result.stderr + result.stdout, /текст службы/);
  assert.equal(result.stdout, "");
});
