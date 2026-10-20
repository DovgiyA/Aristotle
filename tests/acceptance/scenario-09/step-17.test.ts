// T028 фичи 004 — сценарий 9, шаг 9.17: после входов Опорной станции, склеек и отказов на машине
// Ретранслятора нет адресов и истории соединений — ни в файлах, ни в логах; на диске — только
// счётчики (RELAY-24; research R16).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { UPGRADE_PASSAGE } from "@aristotel/protocol";
import { pinnedTlsConnect } from "@aristotel/core";
import { startNetwork, waitFor, type TestRelay } from "../../support/network.ts";

/** Запрос со своим сокетом — чтобы знать порт-источник клиента. */
async function requestFromKnownPort(relay: TestRelay, path: string, upgrade?: string): Promise<number> {
  const socket = await pinnedTlsConnect({ host: "127.0.0.1", port: relay.port }, relay.relay.tlsSpki);
  const localPort = socket.localPort!;
  await new Promise<void>((resolve) => {
    const headers: Record<string, string> = { host: "127.0.0.1" };
    if (upgrade !== undefined) Object.assign(headers, { connection: "Upgrade", upgrade });
    const req = http.request({ method: upgrade === undefined ? "POST" : "GET", path, headers, createConnection: () => socket }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("upgrade", () => resolve());
    req.on("error", () => resolve());
    req.end();
  });
  socket.destroy();
  return localPort;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test("9.17: адресов и истории соединений на машине Ретранслятора нет (RELAY-24)", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  const relay = net.relays[0]!;
  await waitFor(() => relay.server!.passages.hasControl("A"), 5000, "вход Опорной станции");
  const ports: number[] = [];
  ports.push(await requestFromKnownPort(relay, "/relay/v1/vhod/vyzov"));
  ports.push(await requestFromKnownPort(relay, "/relay/v1/prohod/A/vyzov"));
  ports.push(await requestFromKnownPort(relay, "/relay/v1/prohod/A/soedinenie", UPGRADE_PASSAGE)); // отказ: нет ключа
  await relay.stop(); // счётчики пишутся при остановке
  const texts = filesUnder(relay.dir)
    .filter((f) => !f.endsWith(".pem"))
    .map((f) => [f, readFileSync(f, "utf8")] as const);
  texts.push(["лог", relay.logs.join("")]);
  assert.ok(relay.logs.length > 0, "логи Ретранслятора записаны");
  for (const [name, text] of texts) {
    assert.doesNotMatch(text, /remoteAddress|remotePort|remote/i, name);
    for (const port of ports) assert.ok(!text.includes(String(port)), `${name}: порт клиента ${port}`);
  }
  const counters = JSON.parse(readFileSync(join(relay.dir, "counters.json"), "utf8"));
  assert.deepEqual(Object.keys(counters).sort(), ["day", "logins", "refusals", "splices"]);
  assert.ok(counters.logins >= 1);
  assert.ok(counters.refusals >= 1);
  // В install.json — только свой адрес прослушивания и URL, а не адреса клиентов.
  const install = JSON.parse(readFileSync(join(relay.dir, "install.json"), "utf8"));
  assert.deepEqual(Object.keys(install.relay).sort(), ["group", "listen", "url"]);
});
