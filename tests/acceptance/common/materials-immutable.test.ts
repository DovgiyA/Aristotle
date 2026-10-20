// T062 — история 5 фичи 006: записанный Материал не меняется (BANK-11, BANK-13, BANK-14, FR-013 …
// FR-015, SC-005; Clarifications — путь удалённого Материала занят навсегда, замена — новый путь).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAs, startTestService, type TestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase, createTestItem, T } from "../../support/dictionary.ts";
import { materialRequest, sha256Of, syntheticBytes } from "../../support/materials.ts";

async function stand(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const caseId = (await createTestCase(svc, u1)).id;
  return { svc, u1, caseId };
}

async function delivered(svc: TestService, u1: string, caseId: string, path: string, seed = path): Promise<{ id: string; version: number; bytes: Buffer }> {
  const bytes = syntheticBytes(64, seed);
  const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path }));
  assert.equal(res.statusCode, 201, res.body);
  const id = String(res.json().id);
  const put = await svc.app.inject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...svc.authHeaders(u1), "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: bytes });
  assert.equal(put.statusCode, 200, put.body);
  return { id, version: put.json().version, bytes };
}

test("ни один маршрут не меняет sha256, size, path; второй файл — delivery_done (SC-005)", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const m = await delivered(svc, u1, caseId, "x.img");
  for (const change of [{ sha256: "0".repeat(64) }, { size: "1" }, { path: "y.img" }, { station: "x" }, { case: caseId }]) {
    const res = await callAs(svc, u1, "PATCH", `/api/records/${m.id}`, { expectedVersion: m.version, fields: change });
    assert.equal(res.statusCode, 403, JSON.stringify(change));
  }
  const again = await svc.app.inject({ method: "PUT", url: `/api/materials/${m.id}/content`, headers: { ...svc.authHeaders(u1), "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: Buffer.from("другое") });
  assert.equal(again.json().error, "delivery_done");
  const file = join(svc.dir, "materials", "cases", caseId, "x.img");
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o440);
    assert.equal(statSync(join(svc.dir, "materials", "cases", caseId)).mode & 0o777, 0o750);
    assert.equal(statSync(join(svc.dir, "materials", ".incoming")).mode & 0o777, 0o700);
    assert.throws(() => writeFileSync(file, "x"), /EACCES|EPERM/);
  }
});

test("после удаления путь занят; замена — новый Материал с новым путём; действия над удалённым — 409", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const m = await delivered(svc, u1, caseId, "r.img");
  const del = await callAs(svc, svc.seniorId, "POST", `/api/materials/${m.id}/delete`, { expectedVersion: m.version, reason: "замена" });
  assert.equal(del.statusCode, 200, del.body);
  const bytes = syntheticBytes(64, "r2");
  const same = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path: "r.img" }));
  assert.equal(same.statusCode, 409);
  assert.equal(same.json().error, "material_path_taken");
  const replacement = await delivered(svc, u1, caseId, "r-2.img", "r2");
  assert.notEqual(replacement.id, m.id);
  const version = del.json().version as number;
  assert.equal((await callAs(svc, u1, "POST", `/api/materials/${m.id}/kind`, { expectedVersion: version, kind: "photo" })).json().error, "material_deleted");
  assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/materials/${m.id}/delete`, { expectedVersion: version, reason: "ещё" })).json().error, "material_deleted");
  assert.equal((await callAs(svc, u1, "GET", `/api/materials/${m.id}/content`)).json().error, "material_deleted");
});

test("удаление недоставленного убирает .incoming; связь «подтверждается» остаётся с подписью «Материал удалён»", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const bytes = syntheticBytes(300, "partial");
  const reg = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path: "p.img" }));
  const id = String(reg.json().id);
  await svc.app.inject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...svc.authHeaders(u1), "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: bytes.subarray(0, 100) });
  assert.ok(existsSync(join(svc.dir, "materials", ".incoming", id)));
  // Связь «подтверждается» к Материалу: от связи «один_борт» двух Изделий другого Кейса.
  const multi = (await createTestCase(svc, u1, { shape: undefined })).id;
  const a = await createTestItem(svc, u1, multi);
  const b = await createTestItem(svc, u1, multi);
  const base = { confidence: "high", author: u1, source: { kind: "manual" }, case: multi };
  const link = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("same_airframe"), from: a.id, to: b.id, ...base } });
  const support = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("supported_by"), from: link.json().id, to: id, ...base } });
  assert.equal(support.statusCode, 201, support.body);
  const version = Number(svc.db.prepare("SELECT version FROM record WHERE id = ?").get(id)?.["version"]);
  assert.equal((await callAs(svc, svc.seniorId, "POST", `/api/materials/${id}/delete`, { expectedVersion: version, reason: "ошибка" })).statusCode, 200);
  assert.equal(existsSync(join(svc.dir, "materials", ".incoming", id)), false);
  const shown = await callAs(svc, u1, "GET", `/api/records/${support.json().id}`);
  assert.equal(shown.statusCode, 200);
  assert.match(String(shown.json().view.label), /Материал удалён: p\.img/);
});
