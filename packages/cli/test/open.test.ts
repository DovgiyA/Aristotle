// aristotel open --no-browser (contracts/cli.md, research R14 фичи 004): ссылка входа с одноразовым
// токеном запуска печатается, браузер не запускается; токен — файл с правами владельца, и ссылка
// действительно открывает сессию интерфейса (APP-06, STATION-08).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../../tests/support/harness.ts";
import { startNetwork, startStation, waitFor } from "../../../tests/support/network.ts";

test("open --no-browser: ссылка /vhod#<токен>, launch-token только владельцу, по ссылке — сессия интерфейса", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const res = await runCli(["open", "--no-browser", "--data-dir", station.dir, "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const url = new URL(JSON.parse(res.stdout).url as string);
  assert.equal(url.host, `127.0.0.1:${station.server.port}`);
  assert.equal(url.pathname, "/vhod");
  const token = url.hash.slice(1);
  const file = join(station.dir, "launch-token");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token, token);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const base = `http://127.0.0.1:${station.server.port}`;
  const session = await fetch(`${base}/local/ui-session`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ launchToken: token }) });
  assert.equal(session.status, 200);
  assert.match(session.headers.get("set-cookie") ?? "", /^aristotel_session=/);
});
