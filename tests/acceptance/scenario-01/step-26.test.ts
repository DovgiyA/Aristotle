// T053 — сценарий 1, шаг 1.26: У1 меняет вид образа на «извлечённый файл» — отказ; С1 — с повторным
// вводом пароля, «было → стало» в журнале и истории, предупреждение «Материал начнёт уходить
// Держателям» (BANK-62, STATION-12). Агент — фича 016.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase } from "../../support/dictionary.ts";
import { materialRequest, sha256Of, syntheticBytes } from "../../support/materials.ts";

test("1.26: выпуск образа — только Старший с присутствием", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const caseId = (await createTestCase(svc, u1)).id;
  const bytes = syntheticBytes(20, "image");
  const created = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(bytes), size: bytes.length }, { kind: "image" }));
  const id = String(created.json().id);
  const body = { expectedVersion: 1, kind: "extracted_file" };
  const byU1 = await callAs(svc, u1, "POST", `/api/materials/${id}/kind`, body);
  assert.equal(byU1.statusCode, 403);
  assert.equal(byU1.json().error, "material_kind_release");
  assert.equal((await callAs(svc, u1, "POST", `/api/materials/${id}/kind/release`, body)).statusCode, 403);
  const c1 = svc.seniorId;
  const noPresence = await svc.rawInject({ method: "POST", url: `/api/materials/${id}/kind/release`, headers: { ...svc.authHeaders(c1), "content-type": "application/json" }, payload: body });
  assert.equal(noPresence.statusCode, 403);
  assert.equal(noPresence.json().error, "presence_required");
  const released = await callAs(svc, c1, "POST", `/api/materials/${id}/kind/release`, body);
  assert.equal(released.statusCode, 200, released.body);
  assert.equal(released.json().warning, "material_starts_leaving");
  assert.equal(released.json().fields.kind, "extracted_file");
  const journal = svc.db.prepare("SELECT details FROM journal WHERE subjectId = ? AND action = 'material.kind.release'").get(id);
  assert.deepEqual(JSON.parse(String(journal?.["details"])), { from: "image", to: "extracted_file" });
  const history = svc.db.prepare("SELECT before, after FROM record_history WHERE recordId = ? AND field = 'kind' ORDER BY seq").all(id).map((r) => [r["before"], r["after"]]);
  assert.deepEqual(history.at(-1), ['"image"', '"extracted_file"']);
});
