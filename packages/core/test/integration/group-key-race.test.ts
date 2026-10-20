// T069 фичи 003 — создание и восстановление Ключа Группы при одновременных запусках: несколько
// процессов на пустом Банке и после потери файла получают один и тот же ключ, файл и строка group_key
// совпадают; ни один процесс не остаётся с ключом, которого нет в файле (FR-001, FR-015, NET-53;
// research R2, R3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, ensureGroupKey, groupKeyPath, openBank, readInstall, writeInstall } from "../../src/index.ts";

const ENTRY = join(import.meta.dirname, "..", "..", "..", "..", "tests", "support", "ensure-group-key-process.ts");
const PROCESSES = 4;

function runProcess(dir: string): Promise<{ signingKey: string; available: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.once("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`код ${code}: ${err}`))));
  });
}

async function race(dir: string) {
  return await Promise.all(Array.from({ length: PROCESSES }, () => runProcess(dir)));
}

async function stateOf(dir: string) {
  const db = openBank(dir, readInstall(dir));
  try {
    const rows = db.prepare("SELECT signingKey, reason, current FROM group_key ORDER BY rowid").all().map((r) => ({ ...r }));
    const created = Number(db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'group-key.create'").get()?.["n"]);
    const handle = await ensureGroupKey(dir, db);
    return { rows, created, file: handle.info().signingKey, available: handle.available };
  } finally {
    closeDatabase(db);
  }
}

test("одновременные запуски: пустой Банк и потеря файла — один ключ у всех", { timeout: 120_000 }, async (t) => {
  for (let round = 0; round < 3; round++) {
    const dir = mkdtempSync(join(tmpdir(), "aristotel-race-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    closeDatabase(openBank(dir, writeInstall(dir, { role: "base-station" })));

    const first = await race(dir);
    assert.ok(first.every((r) => r.available), `раунд ${round}: доступен у всех`);
    assert.equal(new Set(first.map((r) => r.signingKey)).size, 1, `раунд ${round}: один ключ при установке`);
    let state = await stateOf(dir);
    assert.equal(state.rows.length, 1, `раунд ${round}`);
    assert.equal(state.created, 1, `раунд ${round}: одна запись журнала`);
    assert.equal(state.file, first[0]?.signingKey);
    assert.ok(state.available, `раунд ${round}: файл совпадает с БД`);

    // Файл пропал, Реестра нет — ключ взамен пропавшего тоже один у всех (reason lost).
    rmSync(groupKeyPath(dir));
    const second = await race(dir);
    assert.equal(new Set(second.map((r) => r.signingKey)).size, 1, `раунд ${round}: один ключ при восстановлении`);
    assert.notEqual(second[0]?.signingKey, first[0]?.signingKey);
    state = await stateOf(dir);
    assert.deepEqual(
      state.rows.map((r) => [r["reason"], r["current"]]),
      [
        ["install", 0],
        ["lost", 1],
      ],
      `раунд ${round}`,
    );
    assert.equal(state.created, 2, `раунд ${round}`);
    assert.equal(state.file, second[0]?.signingKey, `раунд ${round}: файл — ключ, который получили процессы`);
    assert.ok(state.available);
  }
});
