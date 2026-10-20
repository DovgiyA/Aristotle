// T050 фичи 004 — сценарий 9, шаг 9.16: на машине Опорной станции через CLI пытаются завести Члена
// Группы, прочитать Запись, снять Секрет, прочитать журнал от имени С1 — отказ: CLI на самой Опорной
// станции — только установка и сопровождение; Члены Группы работают с Банком со Станций (APP-34,
// STATION-07).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../../support/harness.ts";
import { callStation, startNetwork } from "../../support/network.ts";

test("9.16: member add, record get, record secret unmark, journal на Опорной станции — отказ APP-34", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  const created = (await callStation(net, net.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json() as { id: string };
  const count = () => Number(net.server.db.prepare("SELECT (SELECT count(*) FROM member) + (SELECT count(*) FROM record) AS n").get()?.["n"]);
  const before = count();
  for (const args of [
    ["member", "add", "--label", "У3", "--role", "participant"],
    ["record", "get", created.id],
    ["record", "secret", "unmark", created.id, "--expected-version", "1"],
    ["journal"],
  ]) {
    const res = await runCli([...args, "--as", net.seniorId, "--data-dir", net.dir]);
    assert.equal(res.code, 1, args.join(" "));
    assert.match(res.stderr, /Команда работает на Станции/, args.join(" "));
    assert.match(res.stderr, /APP-34/);
  }
  assert.equal(count(), before);
});
