// T040 фичи 004 — сценарий 9, шаг 9.4 без установщика: Станция и Опорная станция — одна программа в
// разных ролях и каталогах данных; прогон CI — Linux, Windows, macOS (APP-01, APP-21, SCOPE-12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readInstall } from "@aristotel/core";
import { acceptOnStand, seniorInvitation, startNetwork, waitFor } from "../../support/network.ts";

test("9.4: Станция и Опорная станция — разные роли одной программы, у Станции нет Банка (BANK-02)", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const { dir } = await acceptOnStand(t, await seniorInvitation(net));
  assert.equal(readInstall(net.dir).role, "base-station");
  assert.equal(readInstall(dir).role, "station");
  assert.equal(readInstall(net.relays[0]!.dir).role, "relay");
  assert.equal(existsSync(join(dir, "bank.sqlite")), false);
  t.diagnostic(`платформа прогона: ${process.platform} ${process.arch}`);
});
