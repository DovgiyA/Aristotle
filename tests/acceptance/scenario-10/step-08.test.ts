// T044 — сценарий 10, шаг 10.8 в части фичи 006: Материал, заверенный отозванной Станцией, У1 заново
// заверяет своей действующей Станцией S3 — S3 пересчитывает SHA-256 по файлу; прежнее Заверение
// остаётся с пометкой «Станция отозвана»; изменённый файл — отказ (STATION-23, STATION-31;
// Clarifications). Приём офлайн-черновика и Формат переноса — фича 009.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../support/harness.ts";
import { materialNetwork, syntheticFile } from "../../support/materials.ts";
import { callStation, startStation, waitFor } from "../../support/network.ts";

test("10.8: повторное Заверение на S3 с пересчётом хэша; прежнее — «Станция отозвана»", async (t) => {
  const { net, u1, s1, caseId, files } = await materialNetwork(t);
  // S2' — Станция У1 без связи: Материал и Заверение только на ней (офлайн-черновик — фича 009).
  await net.relays[0]!.stop();
  const offline = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "d.img", 4000), case: caseId, kind: "image" });
  assert.equal(offline.status, 202, offline.text);
  const id = String(offline.body["id"]);
  await net.relays[0]!.start();
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"), 10_000);
  await callStation(net, net.seniorId, "POST", `/api/stations/${s1.result.stationId}/revoke`, { reason: "revoked" });
  // Файл черновика и его Заверение переданы У1 на носителе (Формат переноса — фича 009).
  const carried = join(files, "carried.img");
  copyFileSync(join(s1.dir, "materials", id), carried);
  const previous = join(files, "carried.zaverenie.json");
  writeFileSync(previous, readFileSync(join(s1.dir, "materials", `${id}.zaverenie.json`)));
  const s3 = await startStation(t, net, u1);
  // Изменённый файл — S3 пересчитывает хэш и отказывает (Clarifications).
  const changed = join(files, "changed.img");
  writeFileSync(changed, Buffer.concat([readFileSync(carried).subarray(0, 3999), Buffer.from("x")]));
  const bad = await runCli(["material", "reattest", changed, "--attestation", previous, "--case", caseId, "--path", "d.img", "--data-dir", s3.dir]);
  assert.equal(bad.code, 1);
  assert.equal(net.server.db.prepare("SELECT 1 AS x FROM record WHERE id = ?").get(id), undefined);
  // Отказ дала и записала в журнал Опорная станция: причина — в ответе и журнале (T081).
  const reject = net.server.db.prepare("SELECT details FROM journal WHERE action = 'material.attestation.reject' AND subjectId = ?").get(id);
  assert.equal(JSON.parse(String(reject?.["details"])).code, "attestation_mismatch");
  const ok = await runCli(["material", "reattest", carried, "--attestation", previous, "--case", caseId, "--path", "d.img", "--data-dir", s3.dir, "--json"]);
  assert.equal(ok.code, 0, ok.stderr);
  const record = JSON.parse(ok.stdout).record as { view: { attestations: { station: string; mark: string | null; current: boolean }[] } };
  assert.deepEqual(
    record.view.attestations.map((a) => [a.station, a.mark, a.current]),
    [
      [s1.result.stationId, "station_revoked", false],
      [s3.result.stationId, null, true],
    ],
  );
  await waitFor(() => s3.server.deliveries.list().every((i) => i.state === "done"), 30_000, "доставка с S3");
});
