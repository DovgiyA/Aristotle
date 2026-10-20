// T020 фичи 003 — сценарий 12, шаг 12.29: файл Ключа Группы пропал или испорчен при применённом
// Реестре — нового ключа служба не создаёт, Ключ Группы «недоступен», остальной Банк работает; после
// возврата файла — снова доступен (NET-53, BANK-52; spec.md US1, сценарии 7, 8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { groupKeyPath } from "@aristotel/core";
import {
  callAs,
  insertRegistryVersion,
  registryDocument,
  restartTestService,
  signDocument,
  startTestService,
  testCoordinatorKey,
} from "../../support/harness.ts";

for (const damage of ["пропал", "испорчен"] as const) {
  test(`12.29: файл Ключа Группы ${damage} при применённом Реестре`, async (t) => {
    let svc = await startTestService(t);
    const c1 = svc.seniorId;
    const key = testCoordinatorKey(1);
    insertRegistryVersion(svc.db, signDocument(registryDocument(svc.db, { coordinatorKeys: [key.publicKey] }), key), c1);
    const before = (await callAs(svc, c1, "GET", "/api/group-key")).json();
    const path = groupKeyPath(svc.dir);
    const saved = readFileSync(path);

    if (damage === "пропал") rmSync(path);
    else writeFileSync(path, "{ испорчен", { mode: 0o600 });
    svc = await restartTestService(t, svc);

    assert.equal(Number(svc.db.prepare("SELECT count(*) AS n FROM group_key").get()?.["n"]), 1, "нового ключа нет");
    const info = (await callAs(svc, c1, "GET", "/api/group-key")).json();
    assert.equal(info.state, "unavailable");
    assert.equal(info.keyFingerprint, before.keyFingerprint);
    const unavailable = svc.db.prepare("SELECT actorId FROM journal WHERE action = 'group-key.unavailable'").all();
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0]?.["actorId"], null);

    // Остальной Банк работает: Записи, журнал, состав Группы.
    const created = await callAs(svc, c1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal((await callAs(svc, c1, "GET", `/api/records/${created.json().id}`)).statusCode, 200);
    assert.equal((await callAs(svc, c1, "GET", "/api/journal")).statusCode, 200);
    assert.equal((await callAs(svc, c1, "GET", "/api/members")).statusCode, 200);

    writeFileSync(path, saved, { mode: 0o600 });
    svc = await restartTestService(t, svc);
    assert.equal((await callAs(svc, c1, "GET", "/api/group-key")).json().state, "available");
  });
}
