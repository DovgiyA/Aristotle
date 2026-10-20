// T008 — тип Записи «Запись о Материале» (research R3 фичи 006; data-model.md «Запись о Материале»;
// BANK-10, BANK-59, INTAKE-06, DATA-12, INBOX-32; Clarifications — Материал без вида в черновике).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUIDv7 } from "node:crypto";
import { createRecord, updateRecordInTx, inTransaction, getRecord, withView } from "@aristotel/core";
import { callAs, startTestService } from "../../../../tests/support/harness.ts";
import { applyTestDictionary, createTestCase, createTestItem, T } from "../../../../tests/support/dictionary.ts";

const SHA = "4c94485e0c21ae6c41ce1dfe7b6bfaceea5ab68e40a2476f50208e526f506080";

/** Запись о Материале как её заводит регистрация (purpose material.register); без него — отказ (T075). */
const createMaterial = (db: Parameters<typeof createRecord>[0], request: Parameters<typeof createRecord>[1], author: string) =>
  createRecord(db, request, author, { action: "material.register", right: "material.register" });

async function stand(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const kase = await createTestCase(svc, u1);
  return { svc, u1, kase };
}

const fields = (caseId: string, extra: Record<string, unknown> = {}) => ({ case: caseId, path: "x.img", sha256: SHA, size: "1", station: randomUUIDv7(), ...extra });

test("Запись о Материале: создаётся без вида, view отмечает неполноту; Кейс и Документ вместе — model_invalid", async (t) => {
  const { svc, u1, kase } = await stand(t);
  const rec = createMaterial(svc.db, { type: "material", fields: fields(kase.id) }, u1);
  assert.equal(rec.fields["kind"], null);
  const view = withView(svc.db, rec).view as { incomplete: string[]; delivery: string };
  assert.deepEqual(view.incomplete, ["kind"]);
  assert.throws(() => createMaterial(svc.db, { type: "material", fields: fields(kase.id, { document: kase.id, path: "y.img" }) }, u1), (e: { code?: string }) => e.code === "model_invalid");
  assert.throws(() => createMaterial(svc.db, { type: "material", fields: { path: "z.img", sha256: SHA, size: "1", station: "s" } }, u1), (e: { code?: string }) => e.code === "model_invalid");
});

test("Материал Документа (BANK-16): владелец обязан быть Документом — до фичи 013 их нет, отказ model_invalid", async (t) => {
  const { svc, u1, kase } = await stand(t);
  const document = { document: kase.id, path: "doc.img", sha256: SHA, size: "1", station: randomUUIDv7() };
  assert.throws(() => createMaterial(svc.db, { type: "material", fields: document }, u1), (e: { code?: string }) => e.code === "model_invalid");
});

test("вид — Код из material_kind; вне перечня, «Прежний файл», «Внешний источник» у Кейса — отказ", async (t) => {
  const { svc, u1, kase } = await stand(t);
  assert.equal(createMaterial(svc.db, { type: "material", fields: fields(kase.id, { kind: "image" }) }, u1).fields["kind"], "image");
  const code = (kind: string, path: string) => {
    try {
      createMaterial(svc.db, { type: "material", fields: fields(kase.id, { kind, path }) }, u1);
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  assert.equal(code("x", "a"), "material_kind_unknown");
  assert.equal(code("legacy_file", "b"), "material_kind_converter_only");
  assert.equal(code("external_source", "c"), "material_kind_owner");
});

test("общий маршрут и createRecord без регистрации Материала не заводят (T075)", async (t) => {
  const { svc, u1, kase } = await stand(t);
  assert.throws(() => createRecord(svc.db, { type: "material", fields: fields(kase.id) }, u1), (e: { code?: string }) => e.code === "material_use_material_routes");
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "material", fields: fields(kase.id) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "material_use_material_routes");
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM record WHERE type = 'material'").get()?.["n"], 0);
});

test("путь проверяется: недопустимый и зарезервированный — отказ", async (t) => {
  const { svc, u1, kase } = await stand(t);
  assert.throws(() => createMaterial(svc.db, { type: "material", fields: fields(kase.id, { path: "../x" }) }, u1), (e: { code?: string }) => e.code === "material_path_invalid");
  assert.throws(() => createMaterial(svc.db, { type: "material", fields: fields(kase.id, { path: "x.zaverenie-1.json" }) }, u1), (e: { code?: string }) => e.code === "material_path_reserved");
});

test("правка общим маршрутом — 403 material_use_material_routes; маршрут Материала меняет только вид", async (t) => {
  const { svc, u1, kase } = await stand(t);
  const rec = createMaterial(svc.db, { type: "material", fields: fields(kase.id) }, u1);
  for (const change of [{ kind: "photo" }, { path: "y.img" }, { sha256: "0".repeat(64) }]) {
    const res = await callAs(svc, u1, "PATCH", `/api/records/${rec.id}`, { expectedVersion: 1, fields: change });
    assert.equal(res.statusCode, 403, JSON.stringify(change));
    assert.equal(res.json().error, "material_use_material_routes");
  }
  const updated = inTransaction(svc.db, () => updateRecordInTx(svc.db, rec.id, { expectedVersion: 1, fields: { kind: "photo" } }, u1, { allowFields: ["kind"], action: "material.kind.set" }));
  assert.equal(updated.fields["kind"], "photo");
  assert.equal(updated.version, 2);
  const journal = svc.db.prepare("SELECT action, caseId FROM journal WHERE subjectId = ? ORDER BY seq").all(rec.id).map((r) => ({ ...r }));
  assert.deepEqual(journal, [
    { action: "material.register", caseId: kase.id },
    { action: "material.kind.set", caseId: kase.id },
  ]);
  assert.throws(
    () => inTransaction(svc.db, () => updateRecordInTx(svc.db, rec.id, { expectedVersion: 2, fields: { path: "z.img" } }, u1, { allowFields: ["kind"] })),
    (e: { code?: string }) => e.code === "material_use_material_routes",
  );
  assert.equal(getRecord(svc.db, rec.id)?.fields["path"], "x.img");
});

test("связь «подтверждается» к Записи о Материале принимается (DATA-12)", async (t) => {
  const { svc, u1, kase } = await stand(t);
  const multi = await createTestCase(svc, u1, { shape: undefined });
  const a = await createTestItem(svc, u1, multi.id);
  const b = await createTestItem(svc, u1, multi.id);
  const base = { confidence: "high", author: u1, source: { kind: "manual" }, case: multi.id };
  const link = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("same_airframe"), from: a.id, to: b.id, ...base } });
  assert.equal(link.statusCode, 201, link.body);
  const rec = createMaterial(svc.db, { type: "material", fields: fields(kase.id) }, u1);
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("supported_by"), from: link.json().id, to: rec.id, ...base } });
  assert.equal(res.statusCode, 201, res.body);
});
