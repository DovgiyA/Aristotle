// T049 фичи 004 — локальная часть на стенде: ключ заперт до пароля; неверный пароль — ключ закрыт,
// соединений нет; верный — вход и прокси /api/* к Опорной станции; Ретранслятор остановлен — 503
// offline, вернулся — связь без пароля; занятый порт — отказ запуска (STATION-05, STATION-09,
// STATION-10, STATION-11; research R13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readInstall } from "@aristotel/core";
import { startLocalServer } from "../../src/index.ts";
import { TEST_STATION_PASSWORD, startNetwork, startStation, waitFor } from "../../../../tests/support/network.ts";

test("заперта до пароля; неверный пароль — 403 password_wrong, соединений нет; верный — вход", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net, net.seniorId, { unlock: false });
  const locked = await station.local("GET", "/api/members");
  assert.deepEqual([locked.status, locked.body["error"]], [423, "station_locked"]);
  assert.equal((await station.local("GET", "/local/state")).body["unlocked"], false);
  const sessionsBefore = Number(net.server.db.prepare("SELECT count(*) AS n FROM station_session").get()?.["n"]);
  const wrong = await station.local("POST", "/local/unlock", { password: "wrong-password-x" });
  assert.deepEqual([wrong.status, wrong.body["error"]], [403, "password_wrong"]);
  assert.equal(Number(net.server.db.prepare("SELECT count(*) AS n FROM station_session").get()?.["n"]), sessionsBefore, "входа нет");
  const ok = await station.local("POST", "/local/unlock", { password: TEST_STATION_PASSWORD });
  assert.equal(ok.status, 200);
  await waitFor(() => station.server.part.session !== undefined, 10_000, "сеанс");
  const members = await station.local("GET", "/api/members");
  assert.equal(members.status, 200);
  assert.ok((members.body["items"] as unknown[]).length >= 1);
  // Пароль на Опорную станцию не уходит (STATION-09): ни в журнале, ни в БД.
  const db = net.server.db.prepare("SELECT group_concat(details) AS d FROM journal").get()?.["d"];
  assert.ok(!String(db).includes(TEST_STATION_PASSWORD));
});

test("Ретранслятор остановлен — 503 offline с временем; вернулся — связь без пароля", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  // Остановка Ретранслятора рвёт и склейки пула: новые запросы — новые склейки, а Прохода нет.
  await net.relays[0]!.stop();
  await waitFor(async () => (await station.local("GET", "/api/members")).status === 503, 10_000, "503 offline");
  const res = await station.local("GET", "/api/members");
  assert.equal(res.body["error"], "offline");
  assert.match(String(res.body["message"]), /Нет связи с Опорной станцией с \d{4}-/);
  await net.relays[0]!.start();
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"), 5000, "вход Опорной станции");
  await waitFor(async () => (await station.local("GET", "/api/members")).status === 200, 10_000, "связь снова");
});

test("порт интерфейса занят — локальная часть не запускается", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const port = readInstall(station.dir).port;
  await station.server.close();
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", () => resolve()));
  t.after(() => blocker.close());
  await assert.rejects(startLocalServer({ dataDir: station.dir }), (e: { code?: string }) => e.code === "EADDRINUSE");
});

test("тайм-аут попытки закрывает и запрос вызова: молчащий Ретранслятор не копит соединения (SC-005)", async (t) => {
  const { createServer } = await import("node:https");
  const { ensureTlsKey } = await import("@aristotel/core");
  const { tempDir } = await import("../../../../tests/support/network.ts");
  const { BaseConnector: Connector } = await import("@aristotel/station");
  const tls = ensureTlsKey(tempDir(t));
  // Ретранслятор принимает TLS, но на вызов не отвечает.
  const server = createServer(tls.serverOptions(), () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const connector = new Connector({
    code: "A",
    passages: [`https://127.0.0.1:${port}`],
    baseTlsSpki: tls.tlsSpki,
    signer: { publicKey: "x", sign: () => new Uint8Array(64) },
    attemptMs: 200,
  });
  for (let i = 0; i < 3; i++) await assert.rejects(connector.openTunnel());
  connector.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const open = await new Promise<number>((resolve, reject) => server.getConnections((error, count) => (error ? reject(error) : resolve(count))));
  assert.equal(open, 0, "зависшие запросы закрыты");
});

test("Ретранслятор отказал ключу (403) — NoPassageError с признаком refused; нет связи — без него", async (t) => {
  const { startNetwork, waitFor } = await import("../../../../tests/support/network.ts");
  const { BaseConnector: Connector, NoPassageError } = await import("@aristotel/station");
  const { keyFromSeed } = await import("../../src/station-key.ts");
  const { ed25519Sign } = await import("@aristotel/protocol");
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const stranger = keyFromSeed(new Uint8Array(32).fill(0x55));
  const make = (passages: string[]) =>
    new Connector({ code: "A", passages, baseTlsSpki: net.server.tls.tlsSpki, signer: { publicKey: stranger.publicKey, sign: (m) => ed25519Sign(stranger.key, m) }, attemptMs: 1000 });
  const refused = make([net.relays[0]!.relay.url]);
  await assert.rejects(refused.openTunnel(), (error: unknown) => error instanceof NoPassageError && error.refused);
  const offline = make(["https://127.0.0.1:1"]);
  await assert.rejects(offline.openTunnel(), (error: unknown) => error instanceof NoPassageError && !error.refused);
});
