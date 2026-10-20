// T052 — сценарий 1, шаг 1.25 без мастера: извлечённый конфиг — вид «извлечённый файл», заголовок LUKS —
// «крипто-задача», и Материал сразу помечен Секретом (BANK-60, BANK-61, ROLE-25; PARSER-10 в части вида).
import { test } from "node:test";
import assert from "node:assert/strict";
import { materialNetwork, syntheticFile } from "../../support/materials.ts";

test("1.25: крипто-задача — Секрет с регистрации, в той же транзакции", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  const config = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "config", 50), case: caseId, kind: "extracted_file" });
  const luks = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "luks-header", 50), case: caseId, kind: "crypto_task" });
  assert.equal(config.status, 201, config.text);
  assert.equal(luks.status, 201, luks.text);
  assert.equal((config.body["record"] as { secret: boolean }).secret, false);
  assert.equal((luks.body["record"] as { secret: boolean }).secret, true);
  const id = String(luks.body["id"]);
  const journal = net.server.db.prepare("SELECT action, details FROM journal WHERE subjectId = ? ORDER BY seq").all(id).map((r) => ({ action: r["action"], details: JSON.parse(String(r["details"])) }));
  assert.equal(journal[0]!.action, "material.register");
  assert.equal(journal[0]!.details.secret, true);
  const history = net.server.db.prepare("SELECT field, after FROM record_history WHERE recordId = ? AND field = '$secret'").all(id);
  assert.equal(history.length, 1);
});
