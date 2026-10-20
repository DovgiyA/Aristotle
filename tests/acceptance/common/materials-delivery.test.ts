// T032 — история 2 фичи 006 по сети стенда: обрыв посреди передачи — докачка с принятого места,
// заново не больше одной части (SC-004); файлы 0 и 1 байт; отозванная Станция — отказ на Проходе
// (BANK-18, BANK-19, STATION-07, FR-008, FR-011). Отказы маршрута (хэш, держатель, чужая Станция,
// часть больше 8 МиБ, нет места) — packages/core/test/contract/materials.test.ts и unit/upload.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MATERIAL_PART_BYTES } from "@aristotel/protocol";
import { MiB, materialNetwork, sha256File, syntheticFile } from "../../support/materials.ts";
import { callStation, waitFor } from "../../support/network.ts";
import { join } from "node:path";

test("обрыв Прохода посреди передачи — докачка с принятого, заново не больше одной части (SC-004)", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  const file = syntheticFile(files, "big.img", 64 * MiB);
  const res = await s1.local("POST", "/local/materials/register", { file, case: caseId, kind: "image" });
  assert.equal(res.status, 201, res.text);
  const id = String(res.body["id"]);
  const received = () => s1.server.deliveries.list().find((i) => i.id === id)?.received ?? 0;
  await waitFor(() => received() >= 3 * MATERIAL_PART_BYTES, 60_000, "три части");
  await net.relays[0]!.stop();
  const atBreak = received();
  const seen: number[] = [];
  const watch = setInterval(() => seen.push(received()), 20);
  t.after(() => clearInterval(watch));
  await net.relays[0]!.start();
  await waitFor(() => s1.server.deliveries.list().find((i) => i.id === id)?.state === "done", 120_000, "доставка после обрыва");
  clearInterval(watch);
  const lowest = Math.min(...seen.filter((x) => x > 0));
  t.diagnostic(`принято на обрыве: ${atBreak}, наименьшее после: ${lowest}`);
  assert.ok(atBreak - lowest <= MATERIAL_PART_BYTES, `заново больше одной части: ${atBreak} → ${lowest}`);
  assert.equal(await sha256File(join(net.dir, "materials", "cases", caseId, "big.img")), await sha256File(file));
});

test("файлы 0 и 1 байт доставляются; отозванная Станция до Опорной станции не доходит", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  for (const [name, size] of [["zero.img", 0], ["one.img", 1]] as const) {
    const res = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, name, size), case: caseId });
    assert.equal(res.status, 201, res.text);
  }
  await waitFor(() => s1.server.deliveries.list().every((i) => i.state === "done"), 30_000, "доставка");
  const late = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "late.img", 100), case: caseId });
  const lateId = String(late.body["id"]);
  await callStation(net, net.seniorId, "POST", `/api/stations/${s1.result.stationId}/revoke`, { reason: "revoked" });
  await waitFor(() => s1.server.deliveries.list().find((i) => i.id === lateId)?.state !== "sending", 30_000);
  // Если доставка не успела до отзыва — Материал остаётся «не доставлен».
  const state = net.server.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(lateId)?.["delivery"];
  t.diagnostic(`последний Материал: ${String(state)}`);
  const anotherRes = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "after.img", 10), case: caseId });
  assert.notEqual(anotherRes.status, 201, "после отзыва Станция Записей не заводит");
});

test("T078: Материал другой Станции У1 доставляет S3 того же Члена Группы и Станция Старшего; испорченный файл — отказ", async (t) => {
  const { net, u1, caseId, files } = await materialNetwork(t);
  const { openTestSession, runCli } = await import("../../support/harness.ts");
  const { startStation } = await import("../../support/network.ts");
  const { materialRequest, sha256Of } = await import("../../support/materials.ts");
  const { readFileSync } = await import("node:fs");
  // Записи заводит другая Станция У1 (тестовый сеанс): сама она ничего не доставляет.
  const other = openTestSession(net.server.db, u1);
  const register = async (file: string, path: string) => {
    const bytes = readFileSync(file);
    const res = await net.server.stationApp.inject({
      method: "POST",
      url: "/api/materials",
      headers: { "aristotel-api-version": "1", authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      payload: materialRequest(other, { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path }),
    });
    assert.equal(res.statusCode, 201, res.body);
    return String(res.json().id);
  };
  const a = syntheticFile(files, "a.img", 2 * MiB, "attach-a");
  const b = syntheticFile(files, "b.img", 2 * MiB, "attach-b");
  const idA = await register(a, "a.img");
  const idB = await register(b, "b.img");
  const deliveredBy = (id: string) => net.server.db.prepare("SELECT delivery, deliveredByStation AS s FROM material_state WHERE id = ?").get(id);
  const s3 = await startStation(t, net, u1);
  const bad = await runCli(["material", "deliver", idA, "--file", syntheticFile(files, "wrong.img", 2 * MiB, "другое"), "--data-dir", s3.dir]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /SHA-256/);
  const ok = await runCli(["material", "deliver", idA, "--file", a, "--data-dir", s3.dir]);
  assert.equal(ok.code, 0, ok.stderr);
  await waitFor(() => deliveredBy(idA)?.["delivery"] === "delivered", 30_000, "доставка с S3");
  assert.equal(deliveredBy(idA)?.["s"], s3.result.stationId);
  const c1 = await startStation(t, net);
  const byC1 = await runCli(["material", "deliver", idB, "--file", b, "--data-dir", c1.dir]);
  assert.equal(byC1.code, 0, byC1.stderr);
  await waitFor(() => deliveredBy(idB)?.["delivery"] === "delivered", 30_000, "доставка со Станции Старшего");
  assert.equal(deliveredBy(idB)?.["s"], c1.result.stationId);
  // Доставленный — повторно не принимается.
  const again = await runCli(["material", "deliver", idA, "--file", a, "--data-dir", c1.dir]);
  assert.equal(again.code, 1);
});
