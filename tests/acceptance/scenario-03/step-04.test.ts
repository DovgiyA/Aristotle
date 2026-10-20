// T020 — сценарий 3, шаг 3.4 в части фичи 006: без связи Станция сама выдаёт Идентификатор, считает
// SHA-256 и подписывает Заверение (BANK-21, STATION-29). Запись на Опорной станции заведёт передача
// офлайн-черновика — фича 009.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAttestationFile, verifyAttestationSignature } from "@aristotel/protocol";
import { materialNetwork, sha256File, syntheticFile } from "../../support/materials.ts";

test("3.4: без связи — Идентификатор, хэш и Заверение на Станции, Записи на Опорной станции нет", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  await net.relays[0]!.stop();
  const file = syntheticFile(files, "x.img", 4096);
  const res = await s1.local("POST", "/local/materials/register", { file, case: caseId, kind: "image" });
  assert.equal(res.status, 202, res.text);
  assert.equal(res.body["record"], null);
  const id = String(res.body["id"]);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(res.body["sha256"], await sha256File(file));
  const attestation = parseAttestationFile(readFileSync(join(s1.dir, "materials", `${id}.zaverenie.json`), "utf8"));
  assert.ok(verifyAttestationSignature(attestation));
  assert.ok(existsSync(join(s1.dir, "materials", id)));
  // Записи нет, и в очередь доставки Материал не встал (contracts/lokalnaya-chast.md).
  assert.equal(net.server.db.prepare("SELECT 1 AS x FROM record WHERE id = ?").get(id), undefined);
  assert.equal(s1.server.deliveries.has(id), false);
});
