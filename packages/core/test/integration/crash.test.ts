// T038 — SC-002: 100 аварийных остановок службы посреди сохранения без частичных изменений (BANK-05).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openDatabase, type Db } from "@aristotel/core";
import { apiRequest, prepareDataDir, spawnService, type DataDir } from "../../../../tests/support/harness.ts";

const ROUNDS = Number(process.env["ARISTOTEL_CRASH_ROUNDS"] ?? 100);

/** Нарушения согласованности Записей, истории и журнала. */
function violations(db: Db): string[] {
  const problems: string[] = [];
  const q = (sql: string) => db.prepare(sql).all();
  // Каждая строка истории покрыта ровно одной записью журнала.
  for (const r of q(`SELECT h.seq FROM record_history h
      WHERE (SELECT count(*) FROM journal j WHERE h.seq BETWEEN j.historyFrom AND j.historyTo) <> 1`)) {
    problems.push(`строка истории ${r["seq"]} без записи журнала`);
  }
  // Каждая запись журнала об изменении указывает на существующие строки истории своей Записи.
  for (const r of q(`SELECT j.seq FROM journal j WHERE j.subjectType = 'record' AND (
      j.historyFrom IS NULL OR
      (SELECT count(*) FROM record_history h WHERE h.seq BETWEEN j.historyFrom AND j.historyTo AND h.recordId = j.subjectId)
        <> j.historyTo - j.historyFrom + 1)`)) {
    problems.push(`запись журнала ${r["seq"]} без истории`);
  }
  // Версия Записи равна числу её изменений в журнале и последней версии в истории.
  for (const r of q(`SELECT r.id FROM record r WHERE
      r.version <> (SELECT count(*) FROM journal j WHERE j.subjectId = r.id) OR
      r.version <> (SELECT max(h.version) FROM record_history h WHERE h.recordId = r.id) OR
      json_extract(r.fields, '$.x') <> (SELECT json_extract(h.after, '$') FROM record_history h
        WHERE h.recordId = r.id AND h.field = 'x' ORDER BY h.seq DESC LIMIT 1)`)) {
    problems.push(`Запись ${r["id"]} расходится с историей и журналом`);
  }
  return problems;
}

async function hammer(data: DataDir, id: string, stopAt: number): Promise<void> {
  // Читаем текущую версию и пишем подряд, пока процесс службы не убит.
  let n = 0;
  while (Date.now() < stopAt) {
    try {
      const current = (await apiRequest(data, "GET", `/api/records/${id}`)).body as { version: number };
      await apiRequest(data, "PATCH", `/api/records/${id}`, { expectedVersion: current.version, fields: { x: `v${n++}` } });
    } catch {
      return;
    }
  }
}

test(`SC-002: ${ROUNDS} остановок SIGKILL посреди сохранения — ни одного частичного изменения`, { timeout: 600_000 }, async (t) => {
  const data = await prepareDataDir(t);
  let service = await spawnService(t, data);
  const created = (await apiRequest(data, "POST", "/api/records", { type: "test.note", fields: { x: "v" } })).body as { id: string };
  await service.stop();

  for (let round = 0; round < ROUNDS; round++) {
    service = await spawnService(t, data);
    const writers = [0, 1, 2].map(() => hammer(data, created.id, Date.now() + 1000));
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 60));
    service.child.kill("SIGKILL");
    await Promise.all(writers);
    await new Promise<void>((resolve) => (service.child.exitCode !== null || service.child.signalCode !== null ? resolve() : service.child.once("exit", () => resolve())));

    const db = openDatabase(join(data.dir, "bank.sqlite"));
    try {
      assert.deepEqual(violations(db), [], `раунд ${round}`);
    } finally {
      db.close();
    }
  }
  const db = openDatabase(join(data.dir, "bank.sqlite"));
  const version = Number(db.prepare("SELECT version FROM record WHERE id = ?").get(created.id)?.["version"]);
  db.close();
  t.diagnostic(`после ${ROUNDS} раундов версия Записи — ${version}`);
  assert.ok(version > 1, "за все раунды не сохранилось ни одного изменения — тест ничего не проверил");
});
