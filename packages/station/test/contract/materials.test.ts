// T023, T035, T046 — контракт Материалов локальной части (contracts/lokalnaya-chast.md фичи 006):
// копия с SHA-256 одним проходом, отказы до работы с файлом, очередь доставки и её перезапуск, повторное
// Заверение с пересчётом хэша (BANK-17, STATION-29, STATION-31; research R1, R6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { startLocalServer } from "@aristotel/station";
import { MiB, materialNetwork, sha256File, syntheticFile } from "../../../../tests/support/materials.ts";
import { TEST_STATION_PASSWORD, waitFor } from "../../../../tests/support/network.ts";

test("регистрация: копия совпадает с источником, только на чтение, .part не остаётся, источник не тронут", async (t) => {
  const { s1, caseId, files } = await materialNetwork(t);
  const file = syntheticFile(files, "x.img", MiB + 1);
  const before = statSync(file).mtimeMs;
  const res = await s1.local("POST", "/local/materials/register", { file, case: caseId });
  assert.equal(res.status, 201, res.text);
  const id = String(res.body["id"]);
  const copy = join(s1.dir, "materials", id);
  assert.equal(await sha256File(copy), await sha256File(file));
  if (process.platform !== "win32") assert.equal(statSync(copy).mode & 0o222, 0);
  assert.deepEqual(readdirSync(join(s1.dir, "materials")).filter((n) => n.endsWith(".part")), []);
  assert.equal(statSync(file).mtimeMs, before);
  assert.deepEqual((res.body["record"] as { view: { incomplete: string[] } }).view.incomplete, ["kind"]);
});

test("отказы до работы с файлом: каталог, нет файла, «Прежний файл», плохой путь; отказ Опорной станции убирает копию", async (t) => {
  const { s1, caseId, files } = await materialNetwork(t);
  const dir = join(files, "dir");
  mkdirSync(dir);
  const call = (body: Record<string, unknown>) => s1.local("POST", "/local/materials/register", { case: caseId, ...body });
  assert.equal((await call({ file: dir })).body["error"], "material_file_not_regular");
  assert.equal((await call({ file: join(files, "нет.img") })).body["error"], "material_file_unreadable");
  const file = syntheticFile(files, "y.img", 100);
  const legacy = await call({ file, kind: "legacy_file" });
  assert.equal(legacy.status, 403);
  assert.equal(legacy.body["error"], "material_kind_converter_only");
  assert.equal((await call({ file, path: "../y.img" })).body["error"], "material_path_invalid");
  assert.equal(existsSync(join(s1.dir, "materials")), false, "до отказов файл не копировался");
  // Кейса нет — отказ Опорной станции до копирования (T083): ни копии, ни Заверения.
  const refused = await s1.local("POST", "/local/materials/register", { file, case: "01900000-0000-7000-8000-000000000000" });
  assert.equal(refused.status, 404);
  assert.equal(existsSync(join(s1.dir, "materials")), false);
  assert.equal((await s1.local("POST", "/local/materials/register", { case: caseId })).status, 400);
});

test("очередь: доставка, queue.json переживает перезапуск локальной части, доставка продолжается", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  const file = syntheticFile(files, "q.img", 24 * MiB);
  const res = await s1.local("POST", "/local/materials/register", { file, case: caseId });
  assert.equal(res.status, 201, res.text);
  const id = String(res.body["id"]);
  // Сразу закрыть локальную часть: доставка прерывается между частями.
  await s1.server.close();
  const queueFile = join(s1.dir, "materials", "queue.json");
  const saved = JSON.parse(readFileSync(queueFile, "utf8")) as { items: { id: string; state: string; received: number }[] };
  const item = saved.items.find((i) => i.id === id);
  assert.ok(item !== undefined);
  t.diagnostic(`на закрытии: ${item.state}, принято ${item.received}`);
  // Перезапуск: очередь из файла, доставка — после открытия Ключа станции.
  const again = await startLocalServer({ dataDir: s1.dir, attemptMs: 2000, retryMs: 100 });
  t.after(() => again.close());
  await again.part.unlock(TEST_STATION_PASSWORD);
  await waitFor(() => again.deliveries.list().find((i) => i.id === id)?.state === "done", 30_000, "доставка после перезапуска");
  const queue = await fetch(`http://127.0.0.1:${again.port}/local/materials/queue`, { headers: { authorization: `Bearer ${readFileSync(join(s1.dir, "access-token"), "utf8").trim()}` } });
  assert.equal(queue.status, 200);
  const record = net.server.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(id);
  assert.equal(record?.["delivery"], "delivered");
});

test("повторное Заверение: пересчёт хэша по файлу; изменённый файл — отказ без Записи", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  // Прежнее Заверение — Станции, которой Банк не знает: подпишем ключом стенда.
  const { ed25519FromSeed, publicKeyText, ed25519Sign, signAttestation } = await import("@aristotel/protocol");
  const key = ed25519FromSeed(new Uint8Array(32).fill(7));
  const file = syntheticFile(files, "r.img", 5000);
  const sha256 = await sha256File(file);
  const previous = signAttestation((m) => ed25519Sign(key, m), {
    material: "01900000-0000-7000-8000-0000000000a1",
    owner: { case: caseId },
    sha256,
    size: "5000",
    station: "01900000-0000-7000-8000-0000000000f1",
    stationKey: publicKeyText(key),
    at: "2026-10-20T09:00:00.000Z",
  });
  const changed = syntheticFile(files, "r2.img", 5000, "другое");
  const bad = await s1.local("POST", "/local/materials/reattest", { file: changed, case: caseId, attestation: previous });
  assert.equal(bad.status, 422);
  assert.equal(bad.body["error"], "attestation_mismatch");
  assert.equal(net.server.db.prepare("SELECT 1 AS x FROM record WHERE id = ?").get(previous.material), undefined);
  const ok = await s1.local("POST", "/local/materials/reattest", { file, case: caseId, attestation: previous });
  assert.equal(ok.status, 201, ok.text);
  const view = (ok.body["record"] as { view: { attestations: { mark: string | null; current: boolean }[] } }).view;
  assert.deepEqual(view.attestations.map((a) => [a.mark, a.current]), [["station_unknown", false], [null, true]]);
});

// --- Фаза 10, схождение (T079, T080, T082, T083) ---

test("T079: копия с Записью, потерянная очередью, подбирается при открытии Ключа станции", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  const res = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "lost.img", 24 * MiB), case: caseId });
  assert.equal(res.status, 201, res.text);
  const id = String(res.body["id"]);
  await s1.server.close();
  // Как будто ответ 201 потерян: в очереди Материала нет.
  const queueFile = join(s1.dir, "materials", "queue.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(queueFile, JSON.stringify({ items: [] }));
  const again = await startLocalServer({ dataDir: s1.dir, attemptMs: 2000, retryMs: 100 });
  t.after(() => again.close());
  await again.part.unlock(TEST_STATION_PASSWORD);
  await waitFor(() => net.server.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(id)?.["delivery"] === "delivered", 30_000, "подобранная копия доставлена");
});

test("T080, T082: пропавшая копия — rejected, очередь идёт дальше; испорченная копия не повторяется", async (t) => {
  const { net, u1, s1, caseId } = await materialNetwork(t);
  await s1.server.close();
  // Записи заводит другая Станция У1 (тестовый сеанс), копии и очередь S1 готовятся вручную: доставка
  // начнётся только после запуска S1.
  const { openTestSession } = await import("../../../../tests/support/harness.ts");
  const { materialRequest, sha256Of, syntheticBytes } = await import("../../../../tests/support/materials.ts");
  const { chmodSync, mkdirSync: mkdir, writeFileSync } = await import("node:fs");
  const other = openTestSession(net.server.db, u1);
  const dir = join(s1.dir, "materials");
  mkdir(dir, { recursive: true });
  const ids: string[] = [];
  for (const name of ["gone", "broken", "fine"]) {
    const bytes = syntheticBytes(3 * MiB, name);
    const res = await net.server.stationApp.inject({
      method: "POST",
      url: "/api/materials",
      headers: { "aristotel-api-version": "1", authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      payload: materialRequest(other, { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path: `${name}.img` }),
    });
    assert.equal(res.statusCode, 201, res.body);
    const id = String(res.json().id);
    ids.push(id);
    if (name === "gone") continue;
    const copy = join(dir, id);
    writeFileSync(copy, name === "broken" ? Buffer.alloc(bytes.length, 1) : bytes);
    chmodSync(copy, 0o444);
  }
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ items: ids.map((id) => ({ id, size: 3 * MiB, received: 0, state: "waiting", error: null })) }));
  const [gone, broken, fine] = ids as [string, string, string];
  const again = await startLocalServer({ dataDir: s1.dir, attemptMs: 2000, retryMs: 100 });
  t.after(() => again.close());
  await again.part.unlock(TEST_STATION_PASSWORD);
  const state = (id: string) => again.deliveries.list().find((i) => i.id === id);
  try {
    await waitFor(() => state(fine)?.state === "done" && state(gone)?.state === "rejected" && state(broken)?.state === "rejected", 30_000, "очередь разобрана");
  } catch (error) {
    t.diagnostic(JSON.stringify(again.deliveries.list()));
    throw error;
  }
  assert.equal(state(gone)?.error, "material_copy_missing");
  assert.equal(state(broken)?.error, "delivery_hash_mismatch");
  // Повтор по просьбе не отправляет испорченную копию снова.
  const token = readFileSync(join(s1.dir, "access-token"), "utf8").trim();
  await fetch(`http://127.0.0.1:${again.port}/local/materials/${broken}/deliver`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state(broken)?.state, "rejected");
});

test("T083: Кейс не в Черновике и Наблюдатель — отказ до копирования файла", async (t) => {
  const { net, s1, caseId, files } = await materialNetwork(t);
  net.server.db.prepare("UPDATE record SET fields = json_set(fields, '$.status', 'in_review') WHERE id = ?").run(caseId);
  const res = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "late.img", 100), case: caseId });
  assert.equal(res.status, 409);
  assert.equal(res.body["error"], "case_not_draft");
  assert.equal(existsSync(join(s1.dir, "materials")), false, "файл не копировался");
});

// --- Фаза 11, схождение (T091, T092, T093) ---

test("T091: «держит другая Станция» — очередь ждёт до until, журнал — одна запись", async (t) => {
  const { net, u1, s1, caseId } = await materialNetwork(t);
  await s1.server.close();
  const { openTestSession } = await import("../../../../tests/support/harness.ts");
  const { materialRequest, sha256Of, syntheticBytes } = await import("../../../../tests/support/materials.ts");
  const { chmodSync, mkdirSync: mkdir, writeFileSync } = await import("node:fs");
  const other = openTestSession(net.server.db, u1);
  const bytes = syntheticBytes(3 * MiB, "held");
  const headers = { "aristotel-api-version": "1", authorization: `Bearer ${other.token}` };
  const reg = await net.server.stationApp.inject({ method: "POST", url: "/api/materials", headers: { ...headers, "content-type": "application/json" }, payload: materialRequest(other, { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path: "held.img" }) });
  const id = String(reg.json().id);
  // Другая Станция У1 начала доставку и держит её.
  await net.server.stationApp.inject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...headers, "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: bytes.subarray(0, MiB) });
  const dir = join(s1.dir, "materials");
  mkdir(dir, { recursive: true });
  writeFileSync(join(dir, id), bytes);
  chmodSync(join(dir, id), 0o444);
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ items: [{ id, size: bytes.length, received: 0, state: "waiting", error: null }] }));
  const again = await startLocalServer({ dataDir: s1.dir, attemptMs: 2000, retryMs: 50 });
  t.after(() => again.close());
  await again.part.unlock(TEST_STATION_PASSWORD);
  await waitFor(() => again.deliveries.list()[0]?.error === "delivery_held", 20_000, "держит другая");
  const item = again.deliveries.list()[0]!;
  // Не каждые retryMs (50 мс), а до until, но не дольше минуты: держателя могут отозвать (T097).
  assert.ok((item.notBefore ?? 0) > Date.now() + 30_000 && (item.notBefore ?? 0) <= Date.now() + 60_000, String(item.notBefore));
  await new Promise((r) => setTimeout(r, 500));
  const rows = net.server.db.prepare("SELECT count(*) AS n FROM journal WHERE subjectId = ? AND action = 'material.deliver.reject'").get(id)?.["n"];
  assert.equal(Number(rows), 1);
});

test("T097: держателя отозвали — доставка идёт при следующей проверке, без ручного повтора", async (t) => {
  const { net, u1, s1, caseId } = await materialNetwork(t);
  await s1.server.close();
  const { openTestSession } = await import("../../../../tests/support/harness.ts");
  const { materialRequest, sha256Of, syntheticBytes } = await import("../../../../tests/support/materials.ts");
  const { chmodSync, mkdirSync: mkdir, writeFileSync } = await import("node:fs");
  const other = openTestSession(net.server.db, u1);
  const bytes = syntheticBytes(MiB, "held-revoked");
  const headers = { "aristotel-api-version": "1", authorization: `Bearer ${other.token}` };
  const id = String((await net.server.stationApp.inject({ method: "POST", url: "/api/materials", headers: { ...headers, "content-type": "application/json" }, payload: materialRequest(other, { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path: "hr.img" }) })).json().id);
  await net.server.stationApp.inject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...headers, "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: bytes.subarray(0, 1000) });
  const dir = join(s1.dir, "materials");
  mkdir(dir, { recursive: true });
  writeFileSync(join(dir, id), bytes);
  chmodSync(join(dir, id), 0o444);
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ items: [{ id, size: bytes.length, received: 0, state: "waiting", error: null }] }));
  const again = await startLocalServer({ dataDir: s1.dir, attemptMs: 2000, retryMs: 50, deliveryMaxWaitMs: 300 });
  t.after(() => again.close());
  await again.part.unlock(TEST_STATION_PASSWORD);
  await waitFor(() => again.deliveries.list()[0]?.error === "delivery_held", 20_000, "держит другая");
  net.server.db.prepare("UPDATE station SET state = 'revoked' WHERE id = ?").run(other.stationId);
  await waitFor(() => again.deliveries.list()[0]?.state === "done", 20_000, "доставка после отзыва держателя");
});

test("T095: стойкая 5xx — пауза растёт вдвое, а не повтор каждые retryMs", async (t) => {
  let puts = 0;
  const { s1, caseId, files } = await materialNetwork(t, {
    extend: (_app, _db, stationApp) => {
      stationApp.addHook("onRequest", async (request, reply) => {
        if (request.method === "PUT" && request.url.endsWith("/content")) {
          puts++;
          return reply.status(500).send({ error: "internal_error", message: "x" });
        }
        return undefined;
      });
    },
  });
  // retryMs стенда — 100 мс: без нарастания было бы ~15 запросов за 1,5 с.
  const res = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "stuck.img", 100), case: caseId });
  assert.equal(res.status, 201, res.text);
  await new Promise((r) => setTimeout(r, 1500));
  const item = s1.server.deliveries.list()[0]!;
  t.diagnostic(`PUT за 1,5 с: ${puts}, попыток: ${item.attempts}`);
  assert.equal(item.state, "waiting");
  assert.ok(puts <= 6, String(puts));
  assert.ok((item.attempts ?? 0) >= 2);
});

test("T096: ошибочное повторное Заверение своего Материала не трогает его копию и Заверение", async (t) => {
  const { s1, caseId, files } = await materialNetwork(t);
  const file = syntheticFile(files, "own.img", 3000, "own");
  const res = await s1.local("POST", "/local/materials/register", { file, case: caseId });
  const id = String(res.body["id"]);
  await waitFor(() => s1.server.deliveries.list()[0]?.state === "done", 20_000);
  const copy = join(s1.dir, "materials", id);
  const attestationPath = join(s1.dir, "materials", `${id}.zaverenie.json`);
  const own = readFileSync(attestationPath, "utf8");
  // Прежнее Заверение «неизвестной Станции» с тем же Идентификатором и хэшем — Опорная станция откажет.
  const { ed25519FromSeed, publicKeyText, ed25519Sign, signAttestation } = await import("@aristotel/protocol");
  const key = ed25519FromSeed(new Uint8Array(32).fill(9));
  const previous = signAttestation((m) => ed25519Sign(key, m), {
    material: id,
    owner: { case: caseId },
    sha256: await sha256File(file),
    size: "3000",
    station: "01900000-0000-7000-8000-0000000000f9",
    stationKey: publicKeyText(key),
    at: "2026-10-20T09:00:00.000Z",
  });
  const refused = await s1.local("POST", "/local/materials/reattest", { file, case: caseId, attestation: previous });
  assert.notEqual(refused.status, 201);
  assert.equal(await sha256File(copy), await sha256File(file), "копия на месте");
  assert.equal(readFileSync(attestationPath, "utf8"), own, "своё Заверение на месте");
  assert.deepEqual(readdirSync(join(s1.dir, "materials")).filter((n) => n.includes(".reattest") || n.endsWith(".part")), []);
});

test("T092: временная ошибка Опорной станции — повтор, а не отказ навсегда", async (t) => {
  let failures = 2;
  const { s1, caseId, files } = await materialNetwork(t, {
    extend: (_app, _db, stationApp) => {
      stationApp.addHook("onRequest", async (request, reply) => {
        if (request.method === "PUT" && request.url.endsWith("/content") && failures > 0) {
          failures--;
          return reply.status(503).send({ error: "storage_unavailable", message: "x" });
        }
        return undefined;
      });
    },
  });
  const res = await s1.local("POST", "/local/materials/register", { file: syntheticFile(files, "flaky.img", 1000), case: caseId });
  assert.equal(res.status, 201, res.text);
  await waitFor(() => s1.server.deliveries.list()[0]?.state === "done", 20_000, "доставка после 503");
  assert.equal(failures, 0);
});

test("T093: attach с другим файлом не трогает исправную копию; верный файл заменяет копию «только чтение»", async (t) => {
  const { net, u1, s1, caseId, files } = await materialNetwork(t);
  await s1.server.close();
  const { openTestSession } = await import("../../../../tests/support/harness.ts");
  const { materialRequest, sha256Of } = await import("../../../../tests/support/materials.ts");
  const { chmodSync, mkdirSync: mkdir, writeFileSync } = await import("node:fs");
  const other = openTestSession(net.server.db, u1);
  const goodFile = syntheticFile(files, "good.img", 4000, "good");
  const bytes = readFileSync(goodFile);
  const reg = await net.server.stationApp.inject({
    method: "POST",
    url: "/api/materials",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${other.token}`, "content-type": "application/json" },
    payload: materialRequest(other, { caseId, sha256: sha256Of(bytes), size: bytes.length }, { path: "good.img" }),
  });
  const id = String(reg.json().id);
  // На S1 уже лежит исправная копия «только чтение» (без Заверения S1 — иначе её подберёт adopt, T094).
  const dir = join(s1.dir, "materials");
  mkdir(dir, { recursive: true });
  const copy = join(dir, id);
  writeFileSync(copy, bytes);
  chmodSync(copy, 0o444);
  const again = await startLocalServer({ dataDir: s1.dir, attemptMs: 2000, retryMs: 100 });
  t.after(() => again.close());
  await again.part.unlock(TEST_STATION_PASSWORD);
  await waitFor(() => again.part.session !== undefined, 10_000);
  const token = readFileSync(join(s1.dir, "access-token"), "utf8").trim();
  const attach = (file: string) =>
    fetch(`http://127.0.0.1:${again.port}/local/materials/${id}/attach`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ file }) });
  const wrong = await attach(syntheticFile(files, "wrong.img", 4000, "wrong"));
  assert.equal(wrong.status, 422);
  assert.equal(((await wrong.json()) as { error: string }).error, "delivery_hash_mismatch");
  assert.deepEqual(readFileSync(copy), bytes, "исправная копия на месте");
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".part")), []);
  const ok = await attach(goodFile);
  assert.equal(ok.status, 202);
  await waitFor(() => net.server.db.prepare("SELECT delivery FROM material_state WHERE id = ?").get(id)?.["delivery"] === "delivered", 20_000, "доставка после attach");
  if (process.platform !== "win32") assert.equal(statSync(copy).mode & 0o222, 0);
});
