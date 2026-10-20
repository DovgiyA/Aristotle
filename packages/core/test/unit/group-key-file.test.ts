// T019 фичи 003 — файл Ключа Группы: формат, права только у учётной записи службы, секретной части нет
// в файлах БД; файл не совпал с открытыми ключами, а Реестра нет, — новый ключ с reason = 'lost'
// (FR-003, BANK-52, NET-53; research R2, R3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtExit } from "../../../../tests/support/harness.ts";
import { closeDatabase, ensureGroupKey, groupKeyPath, openBank, readInstall, writeInstall, type Db } from "../../src/index.ts";

// Каталог удаляется при выходе процесса теста: вторые соединения с Банком тест закрывает в хуках,
// зарегистрированных позже, а на Windows открытый bank.sqlite удалить нельзя (EPERM).
function bank(t: { after: (fn: () => void) => void }): { dir: string; db: Db } {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-group-key-"));
  const db = openBank(dir, writeInstall(dir, { role: "base-station" }));
  t.after(() => closeDatabase(db));
  removeAtExit(dir);
  return { dir, db };
}

test("group-key.json: формат, права 0600, открытые части совпадают с БД", async (t) => {
  const { dir, db } = bank(t);
  const handle = await ensureGroupKey(dir, db);
  const path = groupKeyPath(dir);
  assert.equal(path, join(dir, "group-key.json"));
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.format, "aristotel/klyuch-gruppy/v1");
  assert.equal(typeof file.signing.pkcs8, "string");
  assert.ok(file.encryption.identity.startsWith("AGE-SECRET-KEY-1"));
  assert.equal(typeof file.createdAt, "string");
  if (process.platform === "win32") t.diagnostic("права на Windows задаёт icacls — режим файла не проверяется");
  else assert.equal(statSync(path).mode & 0o777, 0o600);
  const row = db.prepare("SELECT signingKey, encryptionKey, keyFingerprint, reason FROM group_key WHERE current = 1").get();
  const info = handle.info();
  assert.equal(row?.["signingKey"], info.signingKey);
  assert.equal(row?.["encryptionKey"], info.encryptionKey);
  assert.equal(row?.["keyFingerprint"], info.keyFingerprint);
  assert.equal(row?.["reason"], "install");
  assert.ok(handle.available);
});

test("секретной части Ключа Группы нет в bank.sqlite, -wal и -shm (BANK-52)", async (t) => {
  const { dir, db } = bank(t);
  await ensureGroupKey(dir, db);
  const file = JSON.parse(readFileSync(groupKeyPath(dir), "utf8"));
  const secrets = [file.signing.pkcs8, file.encryption.identity, Buffer.from(file.signing.pkcs8, "base64").toString("hex")];
  for (const name of ["bank.sqlite", "bank.sqlite-wal", "bank.sqlite-shm"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `${name} содержит секрет`);
    assert.equal(bytes.includes(Buffer.from(file.signing.pkcs8, "base64")), false, `${name} содержит PKCS#8`);
  }
});

test("повторный запуск не создаёт нового ключа", async (t) => {
  const { dir, db } = bank(t);
  const first = (await ensureGroupKey(dir, db)).info();
  const second = (await ensureGroupKey(dir, db)).info();
  assert.deepEqual(second, first);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM group_key").get()?.["n"]), 1);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'group-key.create'").get()?.["n"]), 1);
});

test("файл не совпадает с БД, Реестра нет — новый ключ с reason lost и журналом", async (t) => {
  const { dir, db } = bank(t);
  const first = (await ensureGroupKey(dir, db)).info();
  rmSync(groupKeyPath(dir));
  const other = mkdtempSync(join(tmpdir(), "aristotel-group-key-"));
  removeAtExit(other);
  const otherDb = openBank(other, writeInstall(other, { role: "base-station" }));
  await ensureGroupKey(other, otherDb);
  closeDatabase(otherDb);
  writeFileSync(groupKeyPath(dir), readFileSync(groupKeyPath(other)), { mode: 0o600 });

  const handle = await ensureGroupKey(dir, db);
  assert.ok(handle.available);
  assert.notEqual(handle.info().signingKey, first.signingKey);
  const rows = db.prepare("SELECT reason, current FROM group_key ORDER BY rowid").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { reason: "install", current: 0 },
    { reason: "lost", current: 1 },
  ]);
  const created = db.prepare("SELECT details FROM journal WHERE action = 'group-key.create' ORDER BY seq").all();
  assert.equal(created.length, 2);
  assert.equal(JSON.parse(String(created[1]?.["details"])).reason, "lost");
  // Новый файл соответствует новой строке БД.
  assert.equal(JSON.parse(readFileSync(groupKeyPath(dir), "utf8")).format, "aristotel/klyuch-gruppy/v1");
  assert.deepEqual((await ensureGroupKey(dir, db)).info(), handle.info());
});

// T061 фичи 003 — два одновременных первых запуска: файл Ключа Группы создаётся без перезаписи (link),
// второй запуск берёт ключ первого; ключ один, файл и строка group_key совпадают (research R3).
test("два одновременных ensureGroupKey на пустом Банке — один ключ, файл совпадает с БД", async (t) => {
  for (let round = 0; round < 10; round++) {
    const { dir, db } = bank(t);
    const second = openBank(dir, readInstall(dir));
    t.after(() => closeDatabase(second));
    const [a, b] = await Promise.all([ensureGroupKey(dir, db), ensureGroupKey(dir, second)]);
    assert.deepEqual(a.info(), b.info(), `раунд ${round}`);
    const rows = db.prepare("SELECT signingKey, current FROM group_key").all();
    assert.equal(rows.length, 1, `раунд ${round}: строк group_key`);
    const file = JSON.parse(readFileSync(groupKeyPath(dir), "utf8"));
    const reopened = await ensureGroupKey(dir, db);
    assert.equal(reopened.info().signingKey, rows[0]?.["signingKey"], `раунд ${round}: файл и БД`);
    assert.ok(reopened.available);
    assert.equal(typeof file.signing.pkcs8, "string");
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'group-key.create'").get()?.["n"]), 1, `раунд ${round}: журнал`);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, `раунд ${round}: временных файлов нет`);
  }
});
