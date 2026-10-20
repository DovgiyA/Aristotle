// Остановка Ретранслятора: Upgrade, пришедший после закрытия Проходов (пока сервер ещё принимает),
// закрывается сразу — иначе такое соединение держит server.close() бесконечно (стресс-прогон 2026-10-18:
// зависал app.close() Ретранслятора с одним управляющим соединением, зарегистрированным после close();
// STATION-02, RELAY-03 — управляющее соединение Опорной станции и Проход).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassageHub } from "../../src/passage.ts";
import { ChallengeStore, TokenStore } from "../../src/login.ts";
import { Counters } from "../../src/counters.ts";

test("после close() Проходы не принимают новых Upgrade: сокет закрыт, ничего не зарегистрировано", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-relay-hub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const counters = new Counters(dir);
  t.after(() => counters.stop());
  const tokens = new TokenStore();
  const hub = new PassageHub(tokens, new ChallengeStore(), counters);
  const { token } = tokens.issue("A");
  hub.close();
  for (const path of ["/relay/v1/prohod/A/upravlenie", "/relay/v1/prohod/A/soedinenie"]) {
    const socket = new PassThrough();
    const req = { url: path, headers: { upgrade: path.endsWith("upravlenie") ? "aristotel-prohod-upravlenie/1" : "aristotel-prohod/1", authorization: `Bearer ${token}` } } as unknown as IncomingMessage;
    assert.equal(hub.handleUpgrade(req, socket, Buffer.alloc(0)), true, path);
    assert.equal(socket.destroyed, true, `${path}: сокет не закрыт`);
  }
  assert.equal(hub.hasControl("A"), false);
});
