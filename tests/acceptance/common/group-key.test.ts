// T018 фичи 003 — US1: Ключ Группы один и тот же для всех ролей, после перезапуска службы и смены
// Старшего; Банк прежней схемы получает ключ при первом запуске; разные Банки — разные ключи
// (NET-01, NET-42, ROLE-34, FR-001, SC-004).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, migrate, openDatabase, writeInstall } from "@aristotel/core";
import { addMember, callAs, groupA, removeAtExit, restartTestService, startTestService, startTestServiceIn } from "../../support/harness.ts";

test("тот же ключ после перезапуска и смены Старшего; разные Банки — разные ключи", async (t) => {
  let svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId, { withoutSecondSenior: true });
  const first = (await callAs(svc, a.n1, "GET", "/api/group-key")).json();

  svc = await restartTestService(t, svc);
  assert.deepEqual((await callAs(svc, a.u1, "GET", "/api/group-key")).json(), first);

  // С1 назначает У2 Старшим и снимает себя — ключ тот же (ROLE-34).
  const u2 = (await callAs(svc, a.c1, "GET", `/api/members/${a.u2}`)).json();
  assert.equal((await callAs(svc, a.c1, "PATCH", `/api/members/${a.u2}`, { expectedVersion: u2.version, role: "senior" })).statusCode, 200);
  const c1 = (await callAs(svc, a.c1, "GET", `/api/members/${a.c1}`)).json();
  assert.equal((await callAs(svc, a.u2, "PATCH", `/api/members/${a.c1}`, { expectedVersion: c1.version, role: "participant" })).statusCode, 200);
  assert.deepEqual((await callAs(svc, a.u2, "GET", "/api/group-key")).json(), first);
  assert.equal(Number(svc.db.prepare("SELECT count(*) AS n FROM group_key").get()?.["n"]), 1);

  const other = await startTestService(t);
  const second = (await callAs(other, other.seniorId, "GET", "/api/group-key")).json();
  assert.notEqual(second.keyFingerprint, first.keyFingerprint);
  assert.notEqual(second.signingKey, first.signingKey);
});

test("Банк схемы 2 без Ключа Группы получает его при первом запуске службы — reason upgrade", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-test-"));
  // Удаление — при выходе: служба стенда закрывает Банк в хуке, зарегистрированном позже (EPERM на Windows).
  removeAtExit(dir);
  const install = writeInstall(dir, { role: "base-station" });
  const db = openDatabase(join(dir, "bank.sqlite"));
  migrate(db, { role: install.role, installId: install.installId, createdAt: install.createdAt }, { target: 2 });
  const senior = addMember(db, "С1", "senior");
  closeDatabase(db);

  const svc = await startTestServiceIn(t, dir, senior);
  const row = svc.db.prepare("SELECT reason, current FROM group_key").get();
  assert.equal(row?.["reason"], "upgrade");
  const journal = svc.db.prepare("SELECT actorId, details FROM journal WHERE action = 'group-key.create'").all();
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.["actorId"], null);
  assert.equal(JSON.parse(String(journal[0]?.["details"])).reason, "upgrade");
  assert.equal((await callAs(svc, senior, "GET", "/api/group-key")).json().state, "available");
});
