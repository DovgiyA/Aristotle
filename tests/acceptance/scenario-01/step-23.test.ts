// T060 — сценарий 1, шаг 1.23: У1 пытается удалить Материал — отказ; С1 удаляет, удаление — в журнале;
// файл и все Заверения убраны из дерева, Запись и история остаются (BANK-12; Clarifications).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { callAs, startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase } from "../../support/dictionary.ts";
import { materialRequest, sha256Of, syntheticBytes } from "../../support/materials.ts";

test("1.23: удаляет только Старший, с записью в журнал", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const caseId = (await createTestCase(svc, u1)).id;
  const bytes = syntheticBytes(40, "delete");
  const created = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path: "del.img", kind: "image" }));
  const id = String(created.json().id);
  const put = await svc.app.inject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...svc.authHeaders(u1), "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: Buffer.from(bytes) });
  assert.equal(put.statusCode, 200, put.body);
  const file = join(svc.dir, "materials", "cases", caseId, "del.img");
  assert.ok(existsSync(file));
  const version = put.json().version as number;
  const byU1 = await callAs(svc, u1, "POST", `/api/materials/${id}/delete`, { expectedVersion: version, reason: "дубль" });
  assert.equal(byU1.statusCode, 403);
  const byC1 = await callAs(svc, svc.seniorId, "POST", `/api/materials/${id}/delete`, { expectedVersion: version, reason: "дубль" });
  assert.equal(byC1.statusCode, 200, byC1.body);
  assert.deepEqual({ by: byC1.json().view.deleted.by, reason: byC1.json().view.deleted.reason }, { by: svc.seniorId, reason: "дубль" });
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.zaverenie-1.json`), false);
  const journal = svc.db.prepare("SELECT actorId, details FROM journal WHERE subjectId = ? AND action = 'material.delete'").get(id);
  assert.equal(journal?.["actorId"], svc.seniorId);
  assert.deepEqual(JSON.parse(String(journal?.["details"])), { sha256: sha256Of(bytes), reason: "дубль" });
  const history = svc.db.prepare("SELECT field FROM record_history WHERE recordId = ? ORDER BY seq").all(id).map((r) => r["field"]);
  assert.ok(history.includes("$deleted"));
  assert.equal((await callAs(svc, u1, "GET", `/api/materials/${id}`)).statusCode, 200, "Запись остаётся");
});
