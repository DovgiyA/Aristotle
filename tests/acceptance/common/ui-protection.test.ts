// T057 фичи 004 — защита интерфейса на loopback по contracts/lokalnaya-chast.md: cookie сессии по
// одноразовому токену запуска, Host, CSRF и Origin, только 127.0.0.1; файлы интерфейса — без внешних
// ресурсов (APP-06, APP-07, APP-27; конституция IV, VI; research R14).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { createConnection } from "node:net";
import { writeFileSync } from "node:fs";
import { startNetwork, startStation, uiLogin, waitFor } from "../../support/network.ts";

function rawGet(port: number, path: string, host: string, cookie = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host, cookie } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

test("APP-06: без cookie — 401; чужой Host — 421; без CSRF, чужой CSRF или Origin — 403; токен запуска одноразовый", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const port = station.server.port;
  const base = `http://127.0.0.1:${port}`;
  const none = await fetch(`${base}/local/state`);
  assert.deepEqual([none.status, ((await none.json()) as { error: string }).error], [401, "ui_session_required"]);
  const ui = await uiLogin(station);
  assert.match(ui.cookie, /^aristotel_session=/);
  // cookie — HttpOnly; SameSite=Strict; Path=/.
  writeFileSync(`${station.dir}/launch-token`, JSON.stringify({ token: "t1", expiresAt: Date.now() + 60_000 }));
  const first = await fetch(`${base}/local/ui-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launchToken: "t1" }) });
  assert.match(first.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict; Path=\//);
  const again = await fetch(`${base}/local/ui-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launchToken: "t1" }) });
  assert.equal(again.status, 401, "токен запуска одноразовый");
  writeFileSync(`${station.dir}/launch-token`, JSON.stringify({ token: "t2", expiresAt: Date.now() - 1 }));
  assert.equal((await fetch(`${base}/local/ui-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launchToken: "t2" }) })).status, 401, "через 2 минуты");
  assert.equal((await ui.call("GET", "/local/state")).status, 200);
  assert.equal(await rawGet(port, "/local/state", "evil.test:" + port, ui.cookie), 421);
  assert.equal(await rawGet(port, "/local/state", `127.0.0.1:${port + 1}`, ui.cookie), 421);
  assert.equal(await rawGet(port, "/local/state", `localhost:${port}`, ui.cookie), 200);
  for (const [label, headers] of [
    ["без CSRF", { "aristotel-csrf": "" }],
    ["чужой CSRF", { "aristotel-csrf": "x" }],
    ["чужой Origin", { origin: "http://evil.test" }],
  ] as const) {
    const res = await ui.call("POST", "/local/activity", undefined, headers);
    assert.deepEqual([res.status, res.body["error"]], [403, "csrf_rejected"], label);
  }
  assert.equal((await ui.call("POST", "/local/activity")).status, 204);
});

test("только 127.0.0.1; страница и файлы без cookie — 200, без внешних ресурсов", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const port = station.server.port;
  const external = Object.values(networkInterfaces()).flat().find((i) => i !== undefined && !i.internal && i.family === "IPv4");
  if (external !== undefined) assert.equal(await canConnect(external.address, port), false);
  assert.equal(await canConnect("::1", port), false);
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<div id="app">/);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/);
  for (const file of ["/app.js", "/app.css", "/vhod"]) assert.equal((await fetch(`${base}${file}`)).status, 200, file);
  const css = await (await fetch(`${base}/app.css`)).text();
  assert.doesNotMatch(css, /url\(|@import|https?:/);
});
