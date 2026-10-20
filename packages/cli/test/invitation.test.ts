// T041 фичи 004 — CLI Приглашений и приёма: invitation issue --senior на Опорной станции (файл с
// правами владельца, строка не в журнале), station accept <файл> и <строка> на Станции через Проход
// (contracts/cli.md; STATION-13, STATION-16, STATION-43); строка или файл передаются вне Сети (STATION-15).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseInvitation } from "@aristotel/protocol";
import { addMember, runCli, writePasswordFile } from "../../../tests/support/harness.ts";
import { TEST_STATION_PASSWORD, seniorInvitation, startNetwork, tempDir, waitFor } from "../../../tests/support/network.ts";

test("invitation issue --senior --out и station accept <файл>; повтор — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const out = join(tempDir(t), "priglashenie.txt");
  const issued = await runCli(["invitation", "issue", "--senior", net.seniorId, "--out", out, "--data-dir", net.dir, "--json"]);
  assert.equal(issued.code, 0, issued.stderr);
  assert.equal(JSON.parse(issued.stdout).out, out);
  assert.equal(JSON.parse(issued.stdout).invitation, undefined);
  const station = tempDir(t, "aristotel-station-");
  assert.equal((await runCli(["init", "--role", "station", "--data-dir", station, "--json"])).code, 0);
  assert.equal(JSON.parse(readFileSync(join(station, "install.json"), "utf8")).port, 47321);
  const pw = writePasswordFile(join(tempDir(t), "pw"), TEST_STATION_PASSWORD);
  const accepted = await runCli(["station", "accept", out, "--password-file", pw, "--data-dir", station, "--json"]);
  assert.equal(accepted.code, 0, accepted.stderr);
  const body = JSON.parse(accepted.stdout);
  assert.equal(body.memberId, net.seniorId);
  assert.match(body.keyFingerprint, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  const again = await runCli(["station", "accept", out, "--password-file", pw, "--data-dir", station]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /уже принята/);
  const journal = net.server.db.prepare("SELECT details FROM journal").all().map((r) => String(r["details"])).join("\n");
  assert.ok(!journal.includes(parseInvitation(readFileSync(out, "utf8")).secret));
});

test("station accept <строка>: Член Группы — Участник; неверная строка — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u3 = addMember(net.server.db, "У3", "senior");
  const text = await seniorInvitation(net, u3);
  const station = tempDir(t, "aristotel-station-");
  await runCli(["init", "--role", "station", "--data-dir", station]);
  const pw = writePasswordFile(join(tempDir(t), "pw"), TEST_STATION_PASSWORD);
  const bad = await runCli(["station", "accept", "aristotel-priglashenie-v1:xxx", "--password-file", pw, "--data-dir", station]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /не разбирается/);
  const ok = await runCli(["station", "accept", text, "--password-file", pw, "--data-dir", station]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Станция принята за\s+У3/);
  const wrongRole = await runCli(["station", "accept", text, "--data-dir", net.dir]);
  assert.equal(wrongRole.code, 1);
  assert.match(wrongRole.stderr, /не для роли base-station/);
});

test("на Станции: invitation issue (с паролем), list, cancel; Ключ Координатора — от Члена Группы Станции", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const { startStation } = await import("../../../tests/support/network.ts");
  const station = await startStation(t, net);
  const u3 = addMember(net.server.db, "У3");
  const pw = writePasswordFile(join(tempDir(t), "pw"), TEST_STATION_PASSWORD);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", station.dir, "--password-file", pw]);
  const out = join(tempDir(t), "u3.txt");
  const issued = await cli("invitation", "issue", u3, "--out", out, "--json");
  assert.equal(issued.code, 0, issued.stderr);
  const id = JSON.parse(issued.stdout).id;
  assert.equal(parseInvitation(readFileSync(out, "utf8")).invitationId, id);
  const list = JSON.parse((await cli("invitation", "list", "--json")).stdout) as { id: string; view: string }[];
  assert.equal(list.find((i) => i.id === id)?.view, "issued");
  const cancelled = await runCli(["invitation", "cancel", id, "--data-dir", station.dir, "--json"]);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout)[0].view, "cancelled");
  // Ключ Координатора: у С1 стенда ключ уже есть — снять (без пароля), затем зарегистрировать новый:
  // файл под своим паролем, подтверждение присутствия — паролем Члена Группы.
  assert.equal((await runCli(["coordinator-key", "withdraw", "--data-dir", station.dir])).code, 0);
  const { writeCoordinatorKeyFile } = await import("../../../tests/support/harness.ts");
  const keyPath = join(tempDir(t), "coordinator.key");
  const publicKey = await writeCoordinatorKeyFile(keyPath, station.dir, "key-password-x");
  const keyPw = writePasswordFile(join(tempDir(t), "kpw"), "key-password-x");
  const registered = await runCli(["coordinator-key", "register", keyPath, "--password-file", keyPw, "--member-password-file", pw, "--data-dir", station.dir, "--json"]);
  assert.equal(registered.code, 0, registered.stderr);
  const row = net.server.db.prepare("SELECT memberId FROM coordinator_key WHERE publicKey = ?").get(publicKey);
  assert.equal(row?.["memberId"], net.seniorId);
});
