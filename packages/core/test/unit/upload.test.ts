// T033 — приём частей и дерево Материалов (research R6, R7, R10 фичи 006; FR-011, SC-003): нехватка
// места не теряет принятое, рестарт службы продолжает с принятого, сбой между размещением в дереве и
// транзакцией доводится при запуске, уборка дерева после удаления доводится при запуске.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { acceptPart, deleteMaterialForTest, reconcileMaterials } from "../../src/materials/test-access.ts";
import { callAs, restartTestService, startTestService, type TestService } from "../../../../tests/support/harness.ts";
import { applyTestDictionary, createTestCase } from "../../../../tests/support/dictionary.ts";
import { materialRequest, sha256Of, syntheticBytes } from "../../../../tests/support/materials.ts";

async function stand(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const caseId = (await createTestCase(svc, u1)).id;
  return { svc, u1, caseId };
}

async function register(svc: TestService, u1: string, caseId: string, data: Uint8Array, path: string): Promise<string> {
  const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(data), size: data.length }, { path }));
  assert.equal(res.statusCode, 201, res.body);
  return String(res.json().id);
}

const actorOf = (svc: TestService, u1: string) => ({ memberId: u1, role: "participant" as const, stationId: svc.session(u1).stationId });

test("ENOSPC: часть не записана, принятое сохранено, докачка после освобождения места", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const data = syntheticBytes(300, "enospc");
  const id = await register(svc, u1, caseId, data, "e.img");
  await acceptPart(svc.db, svc.dir, id, actorOf(svc, u1), 0, data.subarray(0, 100));
  await assert.rejects(
    acceptPart(svc.db, svc.dir, id, actorOf(svc, u1), 100, data.subarray(100, 200), {
      beforeWrite: () => {
        throw Object.assign(new Error("нет места"), { code: "ENOSPC" });
      },
    }),
    (e: { code?: string }) => e.code === "delivery_no_space",
  );
  assert.equal(statSync(join(svc.dir, "materials", ".incoming", id)).size, 100);
  const done = await acceptPart(svc.db, svc.dir, id, actorOf(svc, u1), 100, data.subarray(100));
  assert.equal(done.done, true);
});

test("рестарт службы между частями: смещение из material_upload, недописанный хвост отрезается", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const data = syntheticBytes(500, "restart");
  const id = await register(svc, u1, caseId, data, "r.img");
  await acceptPart(svc.db, svc.dir, id, actorOf(svc, u1), 0, data.subarray(0, 200));
  // Хвост, записанный до сбоя, но не учтённый в БД.
  writeFileSync(join(svc.dir, "materials", ".incoming", id), Buffer.concat([Buffer.from(data.subarray(0, 200)), Buffer.from("мусор")]));
  const actor = actorOf(svc, u1);
  const again = await restartTestService(t, svc);
  const offset = await callAs(again, u1, "GET", `/api/materials/${id}/content/offset`);
  assert.equal(offset.json().received, "200");
  // Та же Станция продолжает после рестарта службы.
  const done = await acceptPart(again.db, again.dir, id, actor, 200, data.subarray(200));
  assert.equal(done.done, true);
});

test("сбой между размещением в дереве и транзакцией — при запуске «доставлен» с recovered; подменённый — убран", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const data = syntheticBytes(64, "crash");
  const id = await register(svc, u1, caseId, data, "c.img");
  await assert.rejects(acceptPart(svc.db, svc.dir, id, actorOf(svc, u1), 0, data, { afterPlace: () => { throw new Error("сбой"); } }), /сбой/);
  assert.equal(svc.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(id)?.["delivery"], "pending");
  await reconcileMaterials(svc.db, svc.dir);
  assert.equal(svc.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(id)?.["delivery"], "delivered");
  const details = JSON.parse(String(svc.db.prepare("SELECT details FROM journal WHERE subjectId = ? AND action = 'material.deliver'").get(id)?.["details"]));
  assert.equal(details.recovered, true);
  // Второй Материал: в дереве оказался чужой файл — убирается, Материал «не доставлен».
  const other = syntheticBytes(64, "crash-2");
  const id2 = await register(svc, u1, caseId, other, "d.img");
  await assert.rejects(acceptPart(svc.db, svc.dir, id2, actorOf(svc, u1), 0, other, { afterPlace: () => { throw new Error("сбой"); } }), /сбой/);
  const placed = join(svc.dir, "materials", "cases", caseId, "d.img");
  chmodSync(placed, 0o600);
  writeFileSync(placed, "x");
  await reconcileMaterials(svc.db, svc.dir);
  assert.equal(existsSync(placed), false);
  assert.equal(svc.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(id2)?.["delivery"], "pending");
});

test("уборка дерева после удаления, сорвавшаяся при удалении, доводится при запуске (research R10)", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const data = syntheticBytes(32, "cleanup");
  const id = await register(svc, u1, caseId, data, "u.img");
  await acceptPart(svc.db, svc.dir, id, actorOf(svc, u1), 0, data);
  const file = join(svc.dir, "materials", "cases", caseId, "u.img");
  assert.deepEqual(readFileSync(file), Buffer.from(data));
  const version = Number(svc.db.prepare("SELECT version FROM record WHERE id = ?").get(id)?.["version"]);
  deleteMaterialForTest(svc.db, svc.dir, id, { expectedVersion: version, reason: "дубль" }, svc.seniorId, { removeTree: () => { throw new Error("сбой"); } });
  assert.equal(existsSync(file), true);
  assert.equal(svc.db.prepare("SELECT treeCleanup FROM material_state WHERE id = ?").get(id)?.["treeCleanup"], 1);
  await reconcileMaterials(svc.db, svc.dir);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.zaverenie-1.json`), false);
  assert.equal(svc.db.prepare("SELECT treeCleanup FROM material_state WHERE id = ?").get(id)?.["treeCleanup"], 0);
});

test("T076: сбойный Материал при согласовании не мешает остальным и запуску службы", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const good = syntheticBytes(16, "good");
  const goodId = await register(svc, u1, caseId, good, "good.img");
  await assert.rejects(acceptPart(svc.db, svc.dir, goodId, actorOf(svc, u1), 0, good, { afterPlace: () => { throw new Error("сбой"); } }), /сбой/);
  // Второй Материал: на месте его файла — каталог (как было бы при пересечении путей).
  const bad = syntheticBytes(16, "bad");
  const badId = await register(svc, u1, caseId, bad, "bad.img");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(svc.dir, "materials", "cases", caseId, "bad.img"), { recursive: true });
  const failed = await reconcileMaterials(svc.db, svc.dir);
  assert.deepEqual(failed, []);
  assert.equal(svc.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(goodId)?.["delivery"], "delivered");
  assert.equal(svc.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(badId)?.["delivery"], "pending");
  // Служба запускается заново.
  const again = await restartTestService(t, svc);
  assert.equal((await callAs(again, u1, "GET", `/api/materials/${goodId}`)).statusCode, 200);
});

test("T087: нет места на Заверения после переименования — delivery_no_space; повтор пустой последней частью доводит доставку", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const data = syntheticBytes(40, "no-space-place");
  const id = await register(svc, u1, caseId, data, "ns.img");
  await assert.rejects(
    acceptPart(svc.db, svc.dir, id, actorOf(svc, u1), 0, data, { afterPlace: () => { throw Object.assign(new Error("нет места"), { code: "ENOSPC" }); } }),
    (e: { code?: string }) => e.code === "delivery_no_space",
  );
  const offset = await callAs(svc, u1, "GET", `/api/materials/${id}/content/offset`);
  assert.equal(offset.json().received, "40");
  const done = await acceptPart(svc.db, svc.dir, id, actorOf(svc, u1), 40, new Uint8Array(0));
  assert.equal(done.done, true);
  assert.equal(svc.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(id)?.["delivery"], "delivered");
});
