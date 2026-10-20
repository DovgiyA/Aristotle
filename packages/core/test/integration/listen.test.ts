// T015 — служба только на loopback; штатная остановка сливает WAL; данные после перезапуска на месте
// (FR-014, STATION-01, RELAY-03, SC-005; research R6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { prepareDataDir, spawnService, apiRequest } from "../../../../tests/support/harness.ts";

function externalAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && a.family === "IPv4") return a.address;
  }
  return undefined;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
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

test("служба слушает только loopback (FR-014)", async (t) => {
  const data = await prepareDataDir(t);
  const svc = await spawnService(t, data);
  assert.equal(await canConnect("127.0.0.1", data.port), true);
  const ext = externalAddress();
  if (ext === undefined) {
    t.diagnostic("у машины нет внешнего IPv4-адреса — проверка внешнего подключения пропущена");
  } else {
    assert.equal(await canConnect(ext, data.port), false);
  }
  await svc.stop();
});

test("после SIGTERM нет -wal и -shm, после нового запуска данные на месте (SC-005)", async (t) => {
  if (process.platform === "win32") {
    t.skip("на Windows SIGTERM дочернему процессу не перехватывается; штатная остановка — служба Windows (фича 018)");
    return;
  }
  const data = await prepareDataDir(t);
  const first = await spawnService(t, data);
  const before = await apiRequest(data, "GET", "/api/test/members");
  await first.stop();
  assert.equal(existsSync(join(data.dir, "bank.sqlite")), true);
  assert.equal(existsSync(join(data.dir, "bank.sqlite-wal")), false);
  assert.equal(existsSync(join(data.dir, "bank.sqlite-shm")), false);
  const second = await spawnService(t, data);
  const after = await apiRequest(data, "GET", "/api/test/members");
  assert.deepEqual(after.body, before.body);
  await second.stop();
});
