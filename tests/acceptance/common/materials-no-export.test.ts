// T070, T072 — Заверение не выходит наружу и данных дел нет (STATION-33, SC-008, SC-009; принцип VII):
// журнал несёт Идентификаторы, хэши и размеры, но не подписи и ключи Заверений; Наблюдателю Заверения
// не отдаются; логи службы и локальной части — без содержимого файлов и Заверений.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addMember } from "../../support/harness.ts";
import { materialNetwork, syntheticFile } from "../../support/materials.ts";
import { callStation, waitFor } from "../../support/network.ts";

test("журнал, ответы Наблюдателю и логи — без подписей, ключей Заверений и содержимого файлов", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  const n1 = addMember(net.server.db, "Н1", "observer");
  const file = syntheticFile(files, "secretless.img", 5000, "no-export");
  const res = await s1.local("POST", "/local/materials/register", { file, case: caseId, kind: "image" });
  assert.equal(res.status, 201, res.text);
  const id = String(res.body["id"]);
  await waitFor(() => s1.server.deliveries.list().every((i) => i.state === "done"), 30_000);
  const attestation = JSON.parse(readFileSync(join(s1.dir, "materials", `${id}.zaverenie.json`), "utf8")) as { signature: string; stationKey: string };
  const journal = net.server.db.prepare("SELECT details FROM journal WHERE details IS NOT NULL").all().map((r) => String(r["details"])).join("\n");
  assert.ok(!journal.includes(attestation.signature), "подпись Заверения в журнале");
  assert.ok(!journal.includes(attestation.stationKey), "ключ Заверения в журнале");
  // Наблюдателю — Запись и файл через программу, но не Заверения.
  assert.equal((await callStation(net, n1, "GET", `/api/materials/${id}`)).statusCode, 200);
  assert.equal((await callStation(net, n1, "GET", `/api/materials/${id}/attestations`)).statusCode, 403);
  const shown = JSON.stringify((await callStation(net, n1, "GET", `/api/materials/${id}`)).json());
  assert.ok(!shown.includes(attestation.signature));
  // Логи — только метод, путь и код ответа.
  const content = readFileSync(file).subarray(0, 32).toString("base64");
  for (const line of [...net.logs, ...s1.logs]) {
    assert.ok(!line.includes(attestation.signature), "подпись в логе");
    assert.ok(!line.includes(content), "содержимое файла в логе");
  }
});
