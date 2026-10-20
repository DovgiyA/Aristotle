// T019 — сценарий 1, шаг 1.17 в части фичи 006: способ снятия, средство снятия и станцию приёмки
// подтверждает человек — в Заверении их нет (STATION-32, INTAKE-04). Подтверждение в мастере — фича 008.
import { test } from "node:test";
import assert from "node:assert/strict";
import { materialNetwork, syntheticFile } from "../../support/materials.ts";

test("1.17: в Заверении только Идентификаторы, хэш, размер, Станция, ключ, время и подпись", async (t) => {
  const { s1, caseId, files } = await materialNetwork(t);
  const res = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "x.img", 1000), case: caseId, kind: "image" });
  assert.equal(res.status, 201, res.text);
  const att = await s1.local("GET", `/api/materials/${String(res.body["id"])}/attestations`);
  assert.equal(att.status, 200, att.text);
  const items = att.body["items"] as { attestation: Record<string, unknown> }[];
  assert.deepEqual(Object.keys(items[0]!.attestation).sort(), ["at", "format", "material", "owner", "sha256", "signature", "size", "station", "stationKey"]);
});
