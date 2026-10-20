// T018 — сценарий 1, шаг 1.5 в части фичи 006: регистрация образа на Станции — Станция считает SHA-256 и
// подписывает Заверение Ключом станции, вида в нём нет; на Опорной станции Запись о Материале с хэшем,
// видом и Заверением, Материал «не доставлен» (BANK-13, BANK-17, BANK-19, BANK-59, STATION-29, STATION-30).
// Подсказка по SHA-256 — фича 011, мастер — фича 008.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyAttestationSignature, type Attestation } from "@aristotel/protocol";
import { MiB, materialNetwork, sha256File, syntheticFile } from "../../support/materials.ts";

test("1.5: образ зарегистрирован — Запись с хэшем, видом и Заверением до доставки файла", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  const file = syntheticFile(files, "obraz.img", 3 * MiB);
  const expected = await sha256File(file);
  const res = await s1.local("POST", "/local/materials/register", { file, case: caseId, kind: "image" });
  assert.equal(res.status, 201, res.text);
  const id = String(res.body["id"]);
  assert.equal(res.body["sha256"], expected);
  assert.equal(res.body["size"], String(3 * MiB));
  // Ответ — Запись в момент заведения: до доставки файла (шаг 1.6).
  const record = res.body["record"] as { fields: Record<string, unknown>; view: { delivery: string; attestations: unknown[] } };
  assert.equal(record.view.delivery, "pending");
  assert.equal(record.fields["sha256"], expected);
  assert.equal(record.fields["kind"], "image");
  assert.equal(record.fields["station"], s1.result.stationId);
  assert.equal(record.view.attestations.length, 1);
  // Копия на Станции и Заверение рядом с ней; вида в Заверении нет.
  assert.ok(existsSync(join(s1.dir, "materials", id)));
  const attestation = JSON.parse(readFileSync(join(s1.dir, "materials", `${id}.zaverenie.json`), "utf8")) as Attestation & Record<string, unknown>;
  assert.ok(verifyAttestationSignature(attestation));
  assert.equal(attestation.sha256, expected);
  assert.equal(attestation.station, s1.result.stationId);
  assert.equal(attestation["kind"], undefined);
  // Журнал Опорной станции: регистрация с Кейсом.
  const row = net.server.db.prepare("SELECT action, caseId FROM journal WHERE subjectId = ? ORDER BY seq LIMIT 1").get(id);
  assert.deepEqual({ ...row }, { action: "material.register", caseId });
});
