// aristotel serve на Опорной станции называет адреса, которые служба действительно слушает: на машине,
// где localhost — только 127.0.0.1 (Linux Mint, /etc/hosts), «[::1]» не печатается (APP-02, APP-06).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { prepareDataDir } from "../../../tests/support/harness.ts";

const CLI = join(import.meta.dirname, "..", "src", "main.ts");

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1000 });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
  });
}

test("serve: напечатанные адреса принимают соединения", async (t) => {
  const data = await prepareDataDir(t);
  const child = spawn(process.execPath, [CLI, "serve", "--data-dir", data.dir], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /Служба Опорной станции слушает ([^\n]+)\n/.exec(out);
      if (found !== null) resolve(found[1]!);
    });
    child.once("exit", (code) => reject(new Error(`serve завершился: ${code}`)));
  });
  const addresses = line.split(/, | и /).map((a) => a.trim());
  assert.ok(addresses.length >= 1, line);
  for (const address of addresses) {
    const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(address);
    assert.ok(match, address);
    assert.equal(Number(match[2]), data.port);
    assert.ok(await connects(match[1]!, data.port), `${address} не принимает соединения`);
  }
});
