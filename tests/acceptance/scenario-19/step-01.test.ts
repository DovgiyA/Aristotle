// T026 — сценарий 19, шаг 19.1 в части фичи 001: программа в роли Опорной станции, служба фоном
// без интерфейса на машине, CLI завёл первого Старшего; автор в журнале — он сам
// (APP-01, APP-02, APP-03, BANK-01, ROLE-26, FR-003). Ключ Группы — T017 фичи 003: служба создала его при
// установке, автор записи журнала — служба (NET-01, NET-02, INBOX-30). Приглашение — фича 004.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { emptyDataDir, freePort, runCli, spawnCli } from "../../support/harness.ts";
import { openDatabase } from "@aristotel/core";

test("19.1: init в роли Опорной станции, служба без интерфейса, первый Старший в журнале", async (t) => {
  const dir = emptyDataDir(t);
  const port = await freePort();

  const init = await runCli(["init", "--role", "base-station", "--senior-label", "С1", "--port", String(port), "--data-dir", dir, "--json"]);
  assert.equal(init.code, 0, init.stderr);
  const created = JSON.parse(init.stdout) as { memberId: string; role: string };
  assert.equal(created.role, "base-station");
  assert.match(created.memberId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);

  const service = await spawnCli(t, ["serve", "--data-dir", dir], /слушает/);

  // Служба отвечает по JSON API (APP-02).
  const version = await fetch(`http://127.0.0.1:${port}/api/version`);
  assert.equal(version.status, 200);
  assert.equal(((await version.json()) as { role: string }).role, "base-station");

  // Интерфейса на машине нет: ни HTML, ни статических файлов, всё вне /api/* — 404 (B1).
  for (const path of ["/", "/index.html", "/app"]) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  }
  await service.stop();

  // Банк — один файл на самой Опорной станции, в её каталоге данных (BANK-01, BANK-04).
  assert.equal(existsSync(join(dir, "bank.sqlite")), true);

  // Журнал: заведение первого Старшего, автор — сам он, пометка cli-init и учётная запись ОС.
  const db = openDatabase(join(dir, "bank.sqlite"));
  t.after(() => db.close());
  const members = db.prepare("SELECT id, label, role, bootstrap FROM member").all().map((r) => ({ ...r }));
  assert.deepEqual(members, [{ id: created.memberId, label: "С1", role: "senior", bootstrap: 1 }]);
  const journal = db.prepare("SELECT actorId, action, subjectType, subjectId, details FROM journal ORDER BY seq").all();
  assert.deepEqual(journal.map((r) => r["action"]), ["group-key.create", "member.bootstrap"]);
  const bootstrap = journal[1];
  assert.equal(bootstrap?.["actorId"], created.memberId);
  assert.equal(bootstrap?.["subjectId"], created.memberId);
  assert.deepEqual(JSON.parse(String(bootstrap?.["details"])), { via: "cli-init", osAccount: userInfo().username });

  // Ключ Группы (T017 фичи 003): создан службой при установке, секретная часть — в своём файле.
  assert.equal(existsSync(join(dir, "group-key.json")), true);
  const keys = db.prepare("SELECT id, keyFingerprint, reason, current FROM group_key").all();
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.["current"], 1);
  assert.equal(keys[0]?.["reason"], "install");
  const created1 = journal[0];
  assert.equal(created1?.["actorId"], null);
  assert.equal(created1?.["subjectType"], "group-key");
  assert.equal(created1?.["subjectId"], keys[0]?.["id"]);
  assert.deepEqual(JSON.parse(String(created1?.["details"])), { reason: "install", keyFingerprint: keys[0]?.["keyFingerprint"] });

  const shown = await runCli(["group-key", "--data-dir", dir, "--json"]);
  // Служба остановлена — CLI сообщает, что она недоступна; отпечаток показывает при работающей службе.
  assert.notEqual(shown.code, 0);
  const again = await spawnCli(t, ["serve", "--data-dir", dir], /слушает/);
  const live = await runCli(["group-key", "--data-dir", dir, "--json"]);
  assert.equal(live.code, 0, live.stderr);
  assert.equal((JSON.parse(live.stdout) as { keyFingerprint: string }).keyFingerprint, keys[0]?.["keyFingerprint"]);
  await again.stop();
});
