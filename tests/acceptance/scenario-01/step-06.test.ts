// T031 — сценарий 1, шаг 1.6 в части фичи 006: Станция доставляет файл через Проход с докачкой;
// Опорная станция сверяет SHA-256 и снимает «не доставлен»; файл в дереве Материалов Кейса, рядом —
// Заверение, файл только на чтение (BANK-10, BANK-11, BANK-18, BANK-19, STATION-07, STATION-30).
// Учёт Рабочей копии — фича 009.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MiB, materialNetwork, sha256File, syntheticFile } from "../../support/materials.ts";
import { waitFor } from "../../support/network.ts";

test("1.6: файл доставлен через Проход, сверен по SHA-256 и лежит в дереве только на чтение", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  const file = syntheticFile(files, "obraz.img", 20 * MiB + 3);
  const expected = await sha256File(file);
  const res = await s1.local("POST", "/local/materials/register", { file, case: caseId, path: "nositel/obraz.img", kind: "image" });
  assert.equal(res.status, 201, res.text);
  const id = String(res.body["id"]);
  await waitFor(() => s1.server.deliveries.list().every((i) => i.state === "done"), 60_000, "доставка");
  const record = await s1.local("GET", `/api/materials/${id}`);
  const view = record.body["view"] as { delivery: string; deliveredByStation: string };
  assert.equal(view.delivery, "delivered");
  assert.equal(view.deliveredByStation, s1.result.stationId);
  const inTree = join(net.dir, "materials", "cases", caseId, "nositel", "obraz.img");
  assert.equal(await sha256File(inTree), expected);
  if (process.platform !== "win32") assert.equal(statSync(inTree).mode & 0o222, 0, "файл Материала только на чтение");
  const attestation = JSON.parse(readFileSync(`${inTree}.zaverenie-1.json`, "utf8"));
  assert.deepEqual(attestation, JSON.parse(readFileSync(join(s1.dir, "materials", `${id}.zaverenie.json`), "utf8")));
  const actions = net.server.db.prepare("SELECT action, details FROM journal WHERE subjectId = ? ORDER BY seq").all(id).map((r) => ({ action: r["action"], via: JSON.parse(String(r["details"] ?? "{}"))["via"] }));
  assert.deepEqual(actions, [
    { action: "material.register", via: undefined },
    { action: "material.deliver", via: "passage" },
  ]);
});
