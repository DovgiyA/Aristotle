// SC-006: запрос журнала с фильтром по Члену Группы на Банке со 100 000 записей журнала —
// 2 секунды или меньше (цель фичи 001); фича 002 — те же запросы от имени Наблюдателя при 1 000
// Секрет-Записей, на которые ссылается каждая сотая запись журнала (research R3 фичи 002). Банк заполняется пакетной вставкой одной транзакцией:
// замеряется чтение журнала через API, а не скорость заполнения. Значения — условные.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { API_VERSION_HEADER } from "@aristotel/protocol";
import { openTestSession } from "../tests/support/harness.ts";
import { buildStationApp, closeDatabase, ensureGroupKey, inTransaction, openBank, readAccessToken, writeInstall } from "@aristotel/core";

const TOTAL = 100_000;
const SECRETS = 1_000;
const LIMIT_MS = 2000;

const dir = mkdtempSync(join(tmpdir(), "aristotel-bench-"));
try {
  const install = writeInstall(dir, { role: "base-station" });
  const db = openBank(dir, install);
  const token = readAccessToken(dir);
  const now = new Date().toISOString();
  const members = ["С1", "У1", "У2", "У3", "Н1"].map((label) => ({ id: randomUUIDv7(), label }));
  // Редкий автор: 10 записей, разбросанных по всему журналу — худший случай для фильтра.
  const rare = { id: randomUUIDv7(), label: "С2" };

  const secretIds: string[] = [];
  const fillStart = performance.now();
  inTransaction(db, () => {
    const addMember = db.prepare("INSERT INTO member (id, label, role, state, createdAt) VALUES (?, ?, ?, 'active', ?)");
    // Роль — по первой букве подписи: С — Старший, Н — Наблюдатель, остальные — Участники (ROLE-04).
    const roleOf = (label: string) => (label.startsWith("С") ? "senior" : label.startsWith("Н") ? "observer" : "participant");
    for (const m of [...members, rare]) addMember.run(m.id, m.label, roleOf(m.label), now);
    const addRecord = db.prepare(
      "INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, 'test.note', 1, '{}', ?, ?, ?, ?, 1)",
    );
    for (let i = 0; i < SECRETS; i++) {
      const id = randomUUIDv7();
      addRecord.run(id, now, now, members[0]!.id, members[0]!.id);
      secretIds.push(id);
    }
    const addJournal = db.prepare(
      "INSERT INTO journal (at, actorId, action, subjectType, subjectId) VALUES (?, ?, 'record.update', 'record', ?)",
    );
    for (let i = 0; i < TOTAL; i++) {
      const actor = i % 10_000 === 0 ? rare : members[i % members.length]!;
      // Каждая сотая запись журнала — о Секрет-Записи: Наблюдатель её не видит.
      addJournal.run(now, actor.id, i % 100 === 50 ? secretIds[(i / 100) % SECRETS | 0]! : randomUUIDv7());
    }
  });
  const fillMs = performance.now() - fillStart;

  // Запросы — в API Станций с сеансом тестовой Станции каждого Члена Группы (фича 004, research R19).
  const app = buildStationApp({ db, install, token, groupKey: await ensureGroupKey(dir, db) });
  const sessions = new Map<string, string>();
  const sessionToken = (memberId: string): string => {
    let found = sessions.get(memberId);
    if (found === undefined) {
      found = openTestSession(db, memberId).token;
      sessions.set(memberId, found);
    }
    return found;
  };
  const observer = members.find((m) => m.label === "Н1")!;
  const measure = async (label: string, url: string, as = members[0]!.id): Promise<number> => {
    const headers = { [API_VERSION_HEADER]: "1", authorization: `Bearer ${sessionToken(as)}` };
    const start = performance.now();
    const res = await app.inject({ method: "GET", url, headers });
    const ms = performance.now() - start;
    if (res.statusCode !== 200) throw new Error(`${label}: код ${res.statusCode}`);
    const { items } = res.json() as { items: unknown[] };
    process.stdout.write(`${label.padEnd(44)} ${ms.toFixed(1).padStart(8)} мс, записей: ${items.length}\n`);
    return ms;
  };

  const total = Number(db.prepare("SELECT count(*) AS n FROM journal").get()?.["n"]);
  process.stdout.write(`Записей журнала: ${total}, заполнение: ${fillMs.toFixed(0)} мс\n`);
  const results = [
    await measure("фильтр по частому автору, первая страница", `/api/journal?member=${members[1]!.id}`),
    await measure("фильтр по частому автору, страница 1000", `/api/journal?member=${members[1]!.id}&limit=1000`),
    await measure("фильтр по редкому автору (10 записей)", `/api/journal?member=${rare.id}`),
    await measure("фильтр по автору с after в конце журнала", `/api/journal?member=${members[2]!.id}&after=${TOTAL - 50}`),
    await measure("Наблюдатель: частый автор, страница 1000", `/api/journal?member=${members[1]!.id}&limit=1000`, observer.id),
    await measure("Наблюдатель: редкий автор (10 записей)", `/api/journal?member=${rare.id}`, observer.id),
    await measure("Наблюдатель: без фильтра, страница 1000", `/api/journal?limit=1000`, observer.id),
    await measure("Наблюдатель: фильтр по Секрет-Записи", `/api/journal?record=${secretIds[0]!}`, observer.id),
  ];
  await app.close();
  closeDatabase(db);
  const worst = Math.max(...results);
  process.stdout.write(`Худший запрос: ${worst.toFixed(1)} мс; цель SC-006 — ${LIMIT_MS} мс\n`);
  if (total < TOTAL || worst > LIMIT_MS) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
