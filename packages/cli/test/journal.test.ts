// T049 фичи 001, T051 фичи 004 — aristotel journal на Станции: таблица и --json с теми же записями,
// фильтры; Наблюдатель — со своей Станции (APP-08, INBOX-32, ROLE-22, VIEW-59).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMember, runCli } from "../../../tests/support/harness.ts";
import { callStation, startNetwork, startStation, waitFor } from "../../../tests/support/network.ts";

test("journal: столбцы, подпись Члена Группы, --json совпадает с таблицей, фильтры", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const dir = (await startStation(t, net)).dir;
  const u2 = addMember(net.server.db, "У2");
  const created = (await callStation(net, net.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).json() as { id: string };
  await callStation(net, u2, "PATCH", `/api/records/${created.id}`, { expectedVersion: 1, fields: { x: "w" } });

  const table = await runCli(["journal", "--data-dir", dir]);
  assert.equal(table.code, 0, table.stderr);
  const lines = table.stdout.trimEnd().split("\n");
  assert.match(lines[0] ?? "", /^seq\s+время\s+кто\s+действие\s+предмет$/);
  // Первая запись — group-key.create от службы (фича 003); затем приём Станции и сеанс (фича 004).
  assert.match(lines[1] ?? "", /служба Опорной станции\s+group-key\.create/);
  assert.ok(lines.some((l) => /служба Опорной станции\s+invitation\.issue/.test(l)));
  assert.ok(lines.some((l) => /С1\s+station\.accept/.test(l)));
  assert.ok(lines.some((l) => /С1\s+station\.session\.start/.test(l)));
  assert.match(lines.at(-1) ?? "", /У2\s+record\.update/);

  const json = await runCli(["journal", "--json", "--data-dir", dir]);
  assert.equal(json.code, 0);
  const items = JSON.parse(json.stdout) as Array<{ seq: number; actorLabel: string; action: string }>;
  assert.deepEqual(
    items.map((i) => String(i.seq)),
    lines.slice(1).map((l) => l.split(/\s+/)[0]),
  );

  const onlyU2 = JSON.parse((await runCli(["journal", "--json", "--member", u2, "--data-dir", dir])).stdout) as Array<{ action: string }>;
  // --member здесь — фильтр журнала; автор запроса — Член Группы Станции.
  assert.deepEqual(onlyU2.map((i) => i.action), ["record.update"]);
  const creates = JSON.parse((await runCli(["journal", "--json", "--action", "record.create", "--data-dir", dir])).stdout) as unknown[];
  assert.equal(creates.length, 1);
  const byRecord = JSON.parse((await runCli(["journal", "--json", "--record", created.id, "--limit", "1", "--data-dir", dir])).stdout) as unknown[];
  assert.equal(byRecord.length, 1);

  // T041 фичи 002 — журнал от имени Наблюдателя (ROLE-22): без записей о Секрет-Записях; --json — те же записи.
  const n1 = addMember(net.server.db, "Н1", "observer");
  const observer = (await startStation(t, net, n1)).dir;
  const secret = (await callStation(net, net.seniorId, "POST", "/api/records", { type: "test.note", fields: { x: "y" }, secret: true })).json() as { id: string };
  const observerTable = await runCli(["journal", "--data-dir", observer]);
  assert.equal(observerTable.code, 0, observerTable.stderr);
  assert.ok(!observerTable.stdout.includes(secret.id));
  const observerJson = JSON.parse((await runCli(["journal", "--json", "--data-dir", observer])).stdout) as Array<{ seq: number | null; subjectId: string }>;
  assert.ok(observerJson.every((i) => i.subjectId !== secret.id));
  // T055 — VIEW-59: у Наблюдателя seq нет; в таблице — номер строки, курсор продолжения — --cursor.
  assert.ok(observerJson.every((i) => i.seq === null));
  const ordinals = observerTable.stdout.trimEnd().split("\n").slice(1).map((l) => l.split(/\s+/)[0]);
  assert.deepEqual(ordinals, observerJson.map((_, i) => String(i + 1)));
  const firstPage = await runCli(["journal", "--limit", "1", "--json", "--data-dir", observer]);
  const cursor = /--cursor (\S+)/.exec(firstPage.stderr)?.[1];
  assert.ok(cursor !== undefined, firstPage.stderr);
  const rest = JSON.parse((await runCli(["journal", "--json", "--cursor", cursor, "--data-dir", observer])).stdout) as unknown[];
  assert.equal(rest.length, observerJson.length - 1);
  const allPages = JSON.parse((await runCli(["journal", "--limit", "1", "--all", "--json", "--data-dir", observer])).stdout) as unknown[];
  assert.equal(allPages.length, observerJson.length);
  const observerAfter = await runCli(["journal", "--after", "1", "--data-dir", observer]);
  assert.equal(observerAfter.code, 1);
  assert.match(observerAfter.stderr, /cursor/);
  const history = await runCli(["record", "history", created.id, "--data-dir", observer]);
  assert.match(history.stdout.split("\n")[1] ?? "", /^1\s+1\s+x/);
  const seniorSees = JSON.parse((await runCli(["journal", "--json", "--record", secret.id, "--data-dir", dir])).stdout) as unknown[];
  assert.equal(seniorSees.length, 1);
});
