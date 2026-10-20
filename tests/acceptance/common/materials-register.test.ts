// T021 — история 1 фичи 006: регистрация Материала (BANK-13, BANK-17, BANK-20, BANK-25, ROLE-10,
// STATION-17; SC-002). Правило «свой черновик» (ROLE-10, ROLE-11) фича 002 отнесла к фичам 008 и 010 —
// здесь его нет, как и у Изделий фичи 005 (tasks.md, Notes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
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

test("два файла с одним содержимым — два Материала с одним SHA-256 (BANK-25)", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const bytes = syntheticBytes(64, "same");
  const facts = { caseId, sha256: sha256Of(bytes), size: bytes.length };
  const a = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), facts, { path: "a.img" }));
  const b = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), facts, { path: "b.img" }));
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.notEqual(a.json().id, b.json().id);
  assert.equal(a.json().fields.sha256, b.json().fields.sha256);
});

test("Наблюдатель — 403; отозванная Станция — Записи нет", async (t) => {
  const { svc, u1, n1, caseId } = await stand(t);
  const bytes = syntheticBytes(10, "roles");
  const facts = { caseId, sha256: sha256Of(bytes), size: bytes.length };
  assert.equal((await callAs(svc, n1, "POST", "/api/materials", materialRequest(svc.session(n1), facts))).statusCode, 403);
  const session = svc.session(u1);
  svc.db.prepare("UPDATE station SET state = 'revoked', revokedAt = ? WHERE id = ?").run(new Date().toISOString(), session.stationId);
  const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(session, facts));
  assert.notEqual(res.statusCode, 201);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM record WHERE type = 'material'").get()?.["n"], 0);
});

test("SC-002: заведение Записи не зависит от размера файла — не больше 2 с и для 1 ТиБ", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const times: number[] = [];
  for (const size of ["1", "1099511627776"]) {
    const started = performance.now();
    const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), { caseId, sha256: "a".repeat(64), size }, { path: `s${size}.img` }));
    times.push(performance.now() - started);
    assert.equal(res.statusCode, 201, res.body);
  }
  t.diagnostic(`заведение Записи: ${times.map((x) => x.toFixed(1)).join(" мс, ")} мс`);
  assert.ok(times.every((x) => x < 2000));
});
