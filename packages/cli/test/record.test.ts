// T043 фичи 001, T051 фичи 004 — aristotel record get / history / secret на Станции: чтение Записи и
// истории таблицей и JSON, метка Секрет (снятие — с паролем, STATION-12); Наблюдатель — со своей
// Станции (APP-08, APP-34; contracts/cli.md; research R19 фичи 004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { addMember, runCli, writePasswordFile } from "../../../tests/support/harness.ts";
import { TEST_STATION_PASSWORD, callStation, startNetwork, startStation, tempDir, waitFor } from "../../../tests/support/network.ts";

test("record get и record history: таблица и --json; ошибки — код 1", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const dir = station.dir;
  const pw = writePasswordFile(join(tempDir(t), "pw"), TEST_STATION_PASSWORD);

  // Записи создаются через API Станций от имени первого Старшего (служебный тип test.note стенда).
  const created = (await callStation(net, net.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json() as { id: string };
  await callStation(net, net.seniorId, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } });

  const getJson = await runCli(["record", "get", created.id, "--json", "--data-dir", dir]);
  assert.equal(getJson.code, 0, getJson.stderr);
  const record = JSON.parse(getJson.stdout) as { version: number; fields: Record<string, unknown> };
  assert.equal(record.version, 2);
  assert.deepEqual(record.fields, { x: "w" });

  const getTable = await runCli(["record", "get", created.id, "--data-dir", dir]);
  assert.equal(getTable.code, 0);
  assert.match(getTable.stdout, /Версия\s+2/);

  const history = await runCli(["record", "history", created.id, "--json", "--data-dir", dir]);
  assert.equal(history.code, 0);
  const items = JSON.parse(history.stdout) as Array<{ before: unknown; after: unknown }>;
  assert.deepEqual(items.map((i) => [i.before, i.after]), [[null, "v"], ["v", "w"]]);

  const historyTable = await runCli(["record", "history", created.id, "--data-dir", dir]);
  assert.match(historyTable.stdout, /seq\s+версия\s+поле\s+было\s+стало\s+кто\s+когда/);
  assert.match(historyTable.stdout, /"v"\s+"w"/);

  const missing = await runCli(["record", "get", "0190d6a0-0000-7000-8000-000000000001", "--data-dir", dir]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /не найдена/);
  // T025 фичи 002 — Наблюдатель читает Запись и историю (ROLE-07) со своей Станции; отказ — по-русски, код 1.
  const n1 = addMember(net.server.db, "Н1", "observer");
  const observer = (await startStation(t, net, n1)).dir;
  const asObserver = await runCli(["record", "get", created.id, "--json", "--data-dir", observer]);
  assert.equal(asObserver.code, 0, asObserver.stderr);
  assert.equal((JSON.parse(asObserver.stdout) as { version: number }).version, 2);
  assert.equal((await runCli(["record", "history", created.id, "--data-dir", observer])).code, 0);
  const observerAdds = await runCli(["member", "add", "--label", "У9", "--role", "participant", "--data-dir", observer, "--password-file", pw]);
  assert.equal(observerAdds.code, 1);
  assert.match(observerAdds.stderr, /Вашей роли это действие не разрешено/);

  // T032 фичи 002 — record secret mark|unmark, столбец «Секрет»; Наблюдателю Секрет-Запись — «не найдена».
  const mark = await runCli(["record", "secret", "mark", created.id, "--expected-version", "2", "--data-dir", dir]);
  assert.equal(mark.code, 0, mark.stderr);
  assert.match(mark.stdout, /Секрет\s+да/);
  const hidden = await runCli(["record", "get", created.id, "--data-dir", observer]);
  assert.equal(hidden.code, 1);
  assert.match(hidden.stderr, /не найдена/);
  const staleMark = await runCli(["record", "secret", "unmark", created.id, "--expected-version", "2", "--data-dir", dir, "--password-file", pw]);
  assert.equal(staleMark.code, 1);
  const unmark = await runCli(["record", "secret", "unmark", created.id, "--expected-version", "3", "--json", "--data-dir", dir, "--password-file", pw]);
  assert.equal(unmark.code, 0, unmark.stderr);
  assert.equal((JSON.parse(unmark.stdout) as { secret: boolean }).secret, false);
  assert.match((await runCli(["record", "get", created.id, "--data-dir", dir])).stdout, /Секрет\s+нет/);
  const badSecret = await runCli(["record", "secret", "hide", created.id, "--expected-version", "4", "--data-dir", dir]);
  assert.equal(badSecret.code, 1);

  const noId = await runCli(["record", "history", "--data-dir", dir]);
  assert.equal(noId.code, 1);
  assert.match(noId.stderr, /Идентификатор/);
});
