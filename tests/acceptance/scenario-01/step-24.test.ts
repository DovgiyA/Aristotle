// T061 — сценарий 1, шаг 1.24: Н1 открывает Материал только через программу — файл отдаёт API;
// Секрет-Материала у Наблюдателя нет ни в списке, ни по Идентификатору (BANK-15, VIEW-16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase } from "../../support/dictionary.ts";
import { materialRequest, sha256Of, syntheticBytes } from "../../support/materials.ts";

test("1.24: Наблюдатель видит Материал только через программу, без Секретов", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const n1 = svc.addMember("Н1", "observer");
  const caseId = (await createTestCase(svc, u1)).id;
  const ids: string[] = [];
  for (const [path, kind] of [["open.img", "image"], ["secret.bin", "crypto_task"]] as const) {
    const bytes = syntheticBytes(30, path);
    const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path, kind }));
    const id = String(res.json().id);
    ids.push(id);
    await svc.app.inject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...svc.authHeaders(u1), "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: Buffer.from(bytes) });
  }
  const [open, secret] = ids as [string, string];
  const file = await callAs(svc, n1, "GET", `/api/materials/${open}/content`);
  assert.equal(file.statusCode, 200);
  assert.deepEqual(file.rawPayload, Buffer.from(syntheticBytes(30, "open.img")));
  assert.equal((await callAs(svc, n1, "GET", `/api/materials/${secret}`)).statusCode, 404);
  assert.equal((await callAs(svc, n1, "GET", `/api/materials/${secret}/content`)).statusCode, 404);
  assert.deepEqual((await callAs(svc, n1, "GET", `/api/materials?case=${caseId}`)).json().items.map((r: { id: string }) => r.id), [open]);
});
