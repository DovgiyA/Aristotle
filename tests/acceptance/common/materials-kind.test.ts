// T055 — история 4 фичи 006: вид Материала (BANK-59 … BANK-63, ROLE-17, ROLE-18, ROLE-24, ROLE-25,
// DICT-60; SC-006, SC-007; Clarifications — первичная постановка вида без Старшего).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService, type TestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase } from "../../support/dictionary.ts";
import { materialRequest, sha256Of, syntheticBytes } from "../../support/materials.ts";

async function stand(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const n1 = svc.addMember("Н1", "observer");
  const caseId = (await createTestCase(svc, u1)).id;
  return { svc, u1, n1, caseId };
}

let n = 0;
async function material(svc: TestService, u1: string, caseId: string, kind?: string): Promise<{ id: string; version: number }> {
  const bytes = syntheticBytes(16, `kind-${n++}`);
  const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(bytes), size: bytes.length }, kind === undefined ? {} : { kind }));
  assert.equal(res.statusCode, 201, res.body);
  return { id: res.json().id, version: res.json().version };
}

async function kind(svc: TestService, who: string, m: { id: string; version: number }, to: string, release = false) {
  return await callAs(svc, who, "POST", `/api/materials/${m.id}/kind${release ? "/release" : ""}`, { expectedVersion: m.version, kind: to });
}

test("вне перечня и неизвестный вид — 422 material_kind_unknown (SC-006)", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  for (const bad of ["x", "IMAGE", "image "]) {
    const bytes = syntheticBytes(8, bad);
    const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: sha256Of(bytes), size: bytes.length }, { kind: bad }));
    assert.equal(res.statusCode, 422, bad);
    assert.equal(res.json().error, "material_kind_unknown");
  }
  const m = await material(svc, u1, caseId);
  assert.equal((await kind(svc, u1, m, "x")).json().error, "material_kind_unknown");
});

test("первичная постановка и образ ⇄ логическая копия — Участником без присутствия", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const m = await material(svc, u1, caseId);
  const set = await svc.rawInject({ method: "POST", url: `/api/materials/${m.id}/kind`, headers: { ...svc.authHeaders(u1), "content-type": "application/json" }, payload: { expectedVersion: 1, kind: "image" } });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().warning, undefined);
  const toCopy = await kind(svc, u1, { id: m.id, version: 2 }, "logical_copy");
  assert.equal(toCopy.statusCode, 200, toCopy.body);
  assert.equal((await kind(svc, u1, { id: m.id, version: 3 }, "image")).statusCode, 200);
  const actions = svc.db.prepare("SELECT action FROM journal WHERE subjectId = ? ORDER BY seq").all(m.id).map((r) => r["action"]);
  assert.deepEqual(actions, ["material.register", "material.kind.set", "material.kind.set", "material.kind.set"]);
});

test("крипто-задача: Секрет ставится, с крипто-задачи не снимается, снять его нельзя никому (SC-007)", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const m = await material(svc, u1, caseId, "photo");
  const toCrypto = await kind(svc, u1, m, "crypto_task");
  assert.equal(toCrypto.statusCode, 200, toCrypto.body);
  assert.equal(toCrypto.json().secret, true);
  const back = await kind(svc, u1, { id: m.id, version: toCrypto.json().version }, "photo");
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().secret, true, "смена с крипто-задачи Секрет не снимает");
  // Бывшая крипто-задача: Секрет не снимает и Старший (T077).
  const unmarkPhoto = await callAs(svc, svc.seniorId, "POST", `/api/records/${m.id}/secret/unmark`, { expectedVersion: back.json().version });
  assert.equal(unmarkPhoto.statusCode, 409);
  assert.equal(unmarkPhoto.json().error, "secret_crypto_task");
  // Снова крипто-задача и попытка Старшего снять Секрет.
  const again = await kind(svc, u1, { id: m.id, version: back.json().version }, "crypto_task");
  const unmark = await callAs(svc, svc.seniorId, "POST", `/api/records/${m.id}/secret/unmark`, { expectedVersion: again.json().version });
  assert.equal(unmark.statusCode, 409);
  assert.equal(unmark.json().error, "secret_crypto_task");
});

test("ручная метка Секрет на Материале: ставит Участник, снимает Старший, Наблюдатель не видит (ROLE-17, ROLE-18, ROLE-24)", async (t) => {
  const { svc, u1, n1, caseId } = await stand(t);
  const m = await material(svc, u1, caseId, "extracted_file");
  const marked = await callAs(svc, u1, "POST", `/api/records/${m.id}/secret/mark`, { expectedVersion: m.version });
  assert.equal(marked.statusCode, 200, marked.body);
  assert.equal((await callAs(svc, n1, "GET", `/api/materials/${m.id}`)).statusCode, 404);
  assert.equal((await callAs(svc, n1, "GET", `/api/materials?case=${caseId}`)).json().items.length, 0);
  const unmarked = await callAs(svc, svc.seniorId, "POST", `/api/records/${m.id}/secret/unmark`, { expectedVersion: marked.json().version });
  assert.equal(unmarked.statusCode, 200, unmarked.body);
  assert.equal((await callAs(svc, n1, "GET", `/api/materials/${m.id}`)).statusCode, 200);
});

test("«Внешний источник» у Кейса — 422; смена вида не в Черновике — 409; устаревшая версия — 409", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const m = await material(svc, u1, caseId, "photo");
  assert.equal((await kind(svc, u1, m, "external_source")).json().error, "material_kind_owner");
  assert.equal((await kind(svc, u1, { id: m.id, version: 99 }, "extracted_file")).statusCode, 409);
  svc.db.prepare("UPDATE record SET fields = json_set(fields, '$.status', 'confirmed') WHERE id = ?").run(caseId);
  const closed = await kind(svc, u1, m, "extracted_file");
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().error, "case_not_draft");
});

test("фото Борта целиком — Материал вида «фото» Кейса Борта (DATA-18)", async (t) => {
  const { svc, u1 } = await stand(t);
  const { EV } = await import("../../support/dictionary.ts");
  const board = (await createTestCase(svc, u1, { shape: EV("case_shape", "airframe") })).id;
  const m = await material(svc, u1, board, "photo");
  const shown = await callAs(svc, u1, "GET", `/api/materials/${m.id}`);
  assert.equal(shown.json().fields.kind, "photo");
  assert.equal(shown.json().fields.case, board);
});

