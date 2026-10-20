// T019 фичи 002, T051 фичи 004 — aristotel member list/get/add/set/revoke по contracts/cli.md фичи 002
// — на Станции: команды идут через локальную часть и сеанс, автор — Член Группы Станции, --as не
// принимается; заведение, смена роли и отзыв — с паролем (APP-08, APP-34, ROLE-21, ROLE-35, ROLE-36,
// STATION-12; research R9 фичи 002, R19 фичи 004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runCli, writePasswordFile } from "../../../tests/support/harness.ts";
import { TEST_STATION_PASSWORD, callStation, startNetwork, startStation, tempDir, waitFor } from "../../../tests/support/network.ts";

test("member: заведение, состав, смена роли, отзыв; отказы — по-русски, код 1", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const c1Station = await startStation(t, net);
  const pw = writePasswordFile(join(tempDir(t), "pw"), TEST_STATION_PASSWORD);
  const cli = (dir: string, ...args: string[]) => runCli([...args, "--data-dir", dir, "--password-file", pw]);
  const c1 = (...args: string[]) => cli(c1Station.dir, ...args);

  // add печатает Идентификатор; --json — запись Члена Группы; пароль — подтверждение присутствия.
  const addU1 = await c1("member", "add", "--label", "У1", "--role", "participant");
  assert.equal(addU1.code, 0, addU1.stderr);
  const u1 = addU1.stdout.trim();
  assert.match(u1, /^[0-9a-f-]{36}$/);
  const addN1 = await c1("member", "add", "--label", "Н1", "--role", "observer", "--json");
  const n1 = (JSON.parse(addN1.stdout) as { id: string; role: string }).id;
  assert.equal((await c1("member", "add", "--label", "С2", "--role", "senior")).code, 0);

  const third = await c1("member", "add", "--label", "С3", "--role", "senior");
  assert.equal(third.code, 1);
  assert.match(third.stderr, /Старших в Группе не больше двух/);

  // list — таблица и --json; Наблюдателю тоже доступно (ROLE-36) — со своей Станции.
  const n1Station = await startStation(t, net, n1);
  const table = await cli(n1Station.dir, "member", "list");
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /Идентификатор\s+подпись\s+роль\s+состояние/);
  assert.match(table.stdout, /У1\s+Участник\s+действует/);
  assert.match(table.stdout, /Н1\s+Наблюдатель\s+действует/);
  const json = JSON.parse((await c1("member", "list", "--json")).stdout) as Array<{ label: string }>;
  assert.deepEqual(json.map((m) => m.label), ["С1", "У1", "Н1", "С2"]);

  // get и set.
  const get = await c1("member", "get", u1, "--json");
  assert.equal((JSON.parse(get.stdout) as { version: number }).version, 1);
  const set = await c1("member", "set", u1, "--expected-version", "1", "--role", "observer");
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Наблюдатель/);
  const stale = await c1("member", "set", u1, "--expected-version", "1", "--label", "x");
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /изменена/);
  // T048 фичи 002 — отказ показывает текущую запись Члена Группы (contracts/cli.md: member set).
  assert.match(stale.stderr, /версия 2/);
  assert.match(stale.stderr, /Наблюдатель/);
  assert.match(stale.stderr, /У1/);
  assert.match(stale.stderr, /действует/);
  const staleRevoke = await c1("member", "revoke", u1, "--expected-version", "1");
  assert.equal(staleRevoke.code, 1);
  assert.match(staleRevoke.stderr, /версия 2/);

  // revoke; Наблюдатель состав не ведёт.
  const revoke = await c1("member", "revoke", u1, "--expected-version", "2");
  assert.equal(revoke.code, 0, revoke.stderr);
  assert.match((await c1("member", "get", u1)).stdout, /отозван/);
  const forbidden = await cli(n1Station.dir, "member", "add", "--label", "У3", "--role", "participant");
  assert.equal(forbidden.code, 1);
  assert.match(forbidden.stderr, /не разрешено/);

  // На Станции --as не принимается: автор — Член Группы Станции (APP-34).
  const as = await c1("member", "list", "--as", n1);
  assert.equal(as.code, 1);
  assert.match(as.stderr, /--as на Станции не принимается/);

  // Неверный пароль — подтверждения присутствия нет, состав не меняется.
  const wrong = writePasswordFile(join(tempDir(t), "wrong"), "wrong-password-x");
  const refused = await runCli(["member", "add", "--label", "У6", "--role", "participant", "--data-dir", c1Station.dir, "--password-file", wrong]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Неверный пароль/);
  assert.equal((await callStation(net, net.seniorId, "GET", "/api/members")).json().items.some((m: { label: string }) => m.label === "У6"), false);

  // Неверные аргументы.
  const noRole = await c1("member", "add", "--label", "У5");
  assert.equal(noRole.code, 1);
  const unknown = await c1("member", "rename", u1);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /aristotel member/);
});
