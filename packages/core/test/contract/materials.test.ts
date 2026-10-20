// T022, T034, T046, T056, T063 — контракт маршрутов Материалов (contracts/http-api.md фичи 006):
// схемы тела и ответа, ошибки, права; регистрация и чтение, доставка, Заверения, вид, удаление.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUIDv7 } from "node:crypto";
import { callAs, startTestService, type TestService } from "../../../../tests/support/harness.ts";
import { applyTestDictionary, createTestCase } from "../../../../tests/support/dictionary.ts";
import { attestAs, materialRequest, sha256Of, syntheticBytes } from "../../../../tests/support/materials.ts";

interface Stand {
  svc: TestService;
  u1: string;
  u2: string;
  n1: string;
  caseId: string;
}

async function stand(t: Parameters<typeof startTestService>[0]): Promise<Stand> {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const u2 = svc.addMember("У2");
  const n1 = svc.addMember("Н1", "observer");
  const kase = await createTestCase(svc, u1);
  return { svc, u1, u2, n1, caseId: kase.id };
}

const bytes = syntheticBytes(1000, "contract");
const facts = (caseId: string) => ({ caseId, sha256: sha256Of(bytes), size: bytes.length });

test("POST /api/materials: 201 с view «не доставлен», GET по Идентификатору и по Кейсу", async (t) => {
  const { svc, u1, n1, caseId } = await stand(t);
  const body = materialRequest(svc.session(u1), facts(caseId), { path: "nositel/x.img", kind: "image" });
  const res = await callAs(svc, u1, "POST", "/api/materials", body);
  assert.equal(res.statusCode, 201, res.body);
  const rec = res.json();
  assert.equal(rec.id, body["id"]);
  assert.equal(rec.type, "material");
  assert.deepEqual(
    { case: rec.fields.case, path: rec.fields.path, sha256: rec.fields.sha256, size: rec.fields.size, kind: rec.fields.kind, station: rec.fields.station },
    { case: caseId, path: "nositel/x.img", sha256: sha256Of(bytes), size: "1000", kind: "image", station: svc.session(u1).stationId },
  );
  assert.equal(rec.view.delivery, "pending");
  assert.deepEqual(rec.view.incomplete, []);
  assert.equal(rec.view.attestations.length, 1);
  assert.equal(rec.view.attestations[0].mark, null);
  assert.equal((await callAs(svc, n1, "GET", `/api/materials/${rec.id}`)).statusCode, 200);
  const list = await callAs(svc, n1, "GET", `/api/materials?case=${caseId}`);
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().items.map((r: { id: string }) => r.id), [rec.id]);
  const journal = svc.db.prepare("SELECT action, caseId, details FROM journal WHERE subjectId = ?").all(rec.id).map((r) => ({ ...r }));
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!["action"], "material.register");
  assert.equal(journal[0]!["caseId"], caseId);
});

test("права: Наблюдатель не регистрирует, Заверения Наблюдателю не отдаются", async (t) => {
  const { svc, u1, n1, caseId } = await stand(t);
  const denied = await callAs(svc, n1, "POST", "/api/materials", materialRequest(svc.session(n1), facts(caseId)));
  assert.equal(denied.statusCode, 403);
  const rec = (await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), facts(caseId)))).json();
  assert.equal((await callAs(svc, n1, "GET", `/api/materials/${rec.id}/attestations`)).statusCode, 403);
  const att = await callAs(svc, u1, "GET", `/api/materials/${rec.id}/attestations`);
  assert.equal(att.statusCode, 200);
  assert.equal(att.json().items[0].attestation.signature.length > 0, true);
});

test("отказы Заверения: формат, подпись, несовпадение, чужая Станция сеанса — с записью в журнал", async (t) => {
  const { svc, u1, u2, caseId } = await stand(t);
  const s1 = svc.session(u1);
  const code = async (body: Record<string, unknown>) => {
    const res = await callAs(svc, u1, "POST", "/api/materials", body);
    return { status: res.statusCode, error: res.json().error as string };
  };
  const id = randomUUIDv7();
  const good = attestAs(s1, { ...facts(caseId), id });
  assert.deepEqual(await code(materialRequest(s1, { ...facts(caseId), id }, { attestation: { ...good, kind: "image" } })), { status: 400, error: "attestation_invalid" });
  assert.deepEqual(await code(materialRequest(s1, { ...facts(caseId), id }, { attestation: { ...good, size: "999" } })), { status: 422, error: "attestation_signature" });
  assert.deepEqual(await code(materialRequest(s1, { ...facts(caseId), id, size: 999 }, { attestation: good })), { status: 422, error: "attestation_mismatch" });
  assert.deepEqual(await code(materialRequest(s1, { ...facts(caseId), id: randomUUIDv7() }, { attestation: good })), { status: 422, error: "attestation_mismatch" });
  // Заверение Станции У2 через сеанс Станции У1.
  assert.deepEqual(await code(materialRequest(svc.session(u2), { ...facts(caseId), id })), { status: 422, error: "attestation_session_station" });
  // Ключ в Заверении не тот, что у Станции в Банке.
  const forged = { ...s1, key: svc.session(u2).key, publicKey: svc.session(u2).publicKey };
  assert.deepEqual(await code(materialRequest(forged, { ...facts(caseId), id })), { status: 422, error: "attestation_key_mismatch" });
  const rejects = svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'material.attestation.reject' AND caseId = ?").get(caseId)?.["n"];
  assert.equal(Number(rejects), 6);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM record WHERE type = 'material'").get()?.["n"], 0);
});

test("путь занят и Идентификатор занят — 409; Кейс не в Черновике — 409 case_not_draft", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const s1 = svc.session(u1);
  const first = materialRequest(s1, facts(caseId), { path: "x.img" });
  assert.equal((await callAs(svc, u1, "POST", "/api/materials", first)).statusCode, 201);
  const taken = await callAs(svc, u1, "POST", "/api/materials", materialRequest(s1, facts(caseId), { path: "X.IMG" }));
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().error, "material_path_taken");
  const again = await callAs(svc, u1, "POST", "/api/materials", materialRequest(s1, { ...facts(caseId), id: String(first["id"]) }, { path: "y.img" }));
  assert.equal(again.json().error, "material_id_taken");
  svc.db.prepare("UPDATE record SET fields = json_set(fields, '$.status', 'in_review') WHERE id = ?").run(caseId);
  const closed = await callAs(svc, u1, "POST", "/api/materials", materialRequest(s1, facts(caseId), { path: "z.img" }));
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().error, "case_not_draft");
});

test("API сопровождения регистрацию не принимает (APP-34)", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const res = await svc.maintenance.inject({ method: "POST", url: "/api/materials", headers: { ...svc.maintenanceHeaders(), "content-type": "application/json" }, payload: materialRequest(svc.session(u1), facts(caseId)) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "maintenance_only");
});

// --- Доставка (T034; research R6) ---

async function put(svc: TestService, member: string, id: string, offset: number | string, chunk: Uint8Array) {
  return await svc.app.inject({
    method: "PUT",
    url: `/api/materials/${id}/content`,
    headers: { ...svc.authHeaders(member), "content-type": "application/octet-stream", "aristotel-offset": String(offset) },
    payload: Buffer.from(chunk),
  });
}

async function registered(s: Stand, data: Uint8Array, extra: { path?: string; kind?: string } = {}) {
  const body = materialRequest(s.svc.session(s.u1), { caseId: s.caseId, sha256: sha256Of(data), size: data.length }, extra);
  const res = await callAs(s.svc, s.u1, "POST", "/api/materials", body);
  assert.equal(res.statusCode, 201, res.body);
  return String(res.json().id);
}

test("доставка частями: смещение, докачка, сверка хэша, файл и Заверение в дереве, чтение с Range", async (t) => {
  const s = await stand(t);
  const data = syntheticBytes(2500, "parts");
  const id = await registered(s, data, { path: "d/x.img" });
  const offset = await callAs(s.svc, s.u1, "GET", `/api/materials/${id}/content/offset`);
  assert.deepEqual(offset.json(), { received: "0", size: "2500" });
  assert.equal((await put(s.svc, s.u1, id, 0, data.subarray(0, 1000))).json().received, "1000");
  const wrong = await put(s.svc, s.u1, id, 0, data.subarray(0, 1000));
  assert.equal(wrong.statusCode, 409);
  assert.deepEqual([wrong.json().error, wrong.json().received], ["delivery_offset", "1000"]);
  assert.equal((await put(s.svc, s.u1, id, 1000, data.subarray(1000, 2000))).statusCode, 200);
  const last = await put(s.svc, s.u1, id, 2000, data.subarray(2000));
  assert.equal(last.statusCode, 200, last.body);
  assert.equal(last.json().view.delivery, "delivered");
  assert.equal(last.json().view.deliveredByStation, s.svc.session(s.u1).stationId);
  const { readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(s.svc.dir, "materials", "cases", s.caseId, "d", "x.img");
  assert.deepEqual(readFileSync(file), Buffer.from(data));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o440);
  const att = JSON.parse(readFileSync(`${file}.zaverenie-1.json`, "utf8"));
  assert.equal(att.material, id);
  assert.equal((await put(s.svc, s.u1, id, 2500, new Uint8Array(1))).json().error, "delivery_done");
  const whole = await callAs(s.svc, s.n1, "GET", `/api/materials/${id}/content`);
  assert.equal(whole.statusCode, 200);
  assert.deepEqual(whole.rawPayload, Buffer.from(data));
  const part = await s.svc.app.inject({ method: "GET", url: `/api/materials/${id}/content`, headers: { ...s.svc.authHeaders(s.n1), range: "bytes=10-19" } });
  assert.equal(part.statusCode, 206);
  assert.deepEqual(part.rawPayload, Buffer.from(data.subarray(10, 20)));
  const journal = s.svc.db.prepare("SELECT action, details FROM journal WHERE subjectId = ? ORDER BY seq").all(id).map((r) => String(r["action"]));
  assert.deepEqual(journal, ["material.register", "material.deliver"]);
});

test("подмена байта — 422 delivery_hash_mismatch, файла в дереве нет, принятое сброшено", async (t) => {
  const s = await stand(t);
  const data = syntheticBytes(100, "swap");
  const id = await registered(s, data, { path: "y.img" });
  const bad = Buffer.from(data);
  bad[50] = bad[50]! ^ 1;
  const res = await put(s.svc, s.u1, id, 0, bad);
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, "delivery_hash_mismatch");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  assert.equal(existsSync(join(s.svc.dir, "materials", "cases", s.caseId, "y.img")), false);
  assert.equal(existsSync(join(s.svc.dir, "materials", ".incoming", id)), false);
  assert.equal((await callAs(s.svc, s.u1, "GET", `/api/materials/${id}`)).json().view.delivery, "pending");
  assert.deepEqual((await callAs(s.svc, s.u1, "GET", `/api/materials/${id}/content/offset`)).json(), { received: "0", size: "100" });
  assert.equal((await put(s.svc, s.u1, id, 0, data)).json().view.delivery, "delivered");
  const actions = s.svc.db.prepare("SELECT action FROM journal WHERE subjectId = ? ORDER BY seq").all(id).map((r) => String(r["action"]));
  assert.deepEqual(actions, ["material.register", "material.deliver.reject", "material.deliver"]);
});

test("кто доставляет: другая Станция того же Члена Группы — после броска, Станция Старшего — сразу; чужая — 403", async (t) => {
  const s = await stand(t);
  const data = syntheticBytes(300, "who");
  const id = await registered(s, data, { path: "w.img" });
  assert.equal((await put(s.svc, s.u1, id, 0, data.subarray(0, 100))).statusCode, 200);
  const foreign = await put(s.svc, s.u2, id, 100, data.subarray(100, 200));
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error, "delivery_station");
  // Вторая Станция У1: доставку держит первая, пока не брошена.
  const { openTestSession } = await import("../../../../tests/support/harness.ts");
  const s3 = openTestSession(s.svc.db, s.u1);
  const headers = { "aristotel-api-version": "1", authorization: `Bearer ${s3.token}`, "content-type": "application/octet-stream" };
  const held = await s.svc.rawInject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...headers, "aristotel-offset": "100" }, payload: Buffer.from(data.subarray(100, 200)) });
  assert.equal(held.statusCode, 409);
  assert.equal(held.json().error, "delivery_held");
  // Станция Старшего перехватывает сразу.
  const byC1 = await put(s.svc, s.svc.seniorId, id, 100, data.subarray(100));
  assert.equal(byC1.statusCode, 200, byC1.body);
  assert.equal(byC1.json().view.deliveredByStation, s.svc.session(s.svc.seniorId).stationId);
  const details = JSON.parse(String(s.svc.db.prepare("SELECT details FROM journal WHERE subjectId = ? AND action = 'material.deliver'").get(id)?.["details"]));
  assert.equal(details.takenOverFrom, s.svc.session(s.u1).stationId);
  // Заверение не переподписывается: одно, Станции У1.
  assert.deepEqual(byC1.json().view.attestations.map((a: { station: string }) => a.station), [s.svc.session(s.u1).stationId]);
});

test("часть больше 8 МиБ или за размером — 413; пустой Материал доставляется пустой частью", async (t) => {
  const s = await stand(t);
  const data = syntheticBytes(10, "big");
  const id = await registered(s, data, { path: "b.img" });
  assert.equal((await put(s.svc, s.u1, id, 0, syntheticBytes(11, "x"))).statusCode, 413);
  const empty = new Uint8Array(0);
  const zero = await registered(s, empty, { path: "zero.img" });
  const done = await put(s.svc, s.u1, zero, 0, empty);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().view.delivery, "delivered");
  assert.equal((await callAs(s.svc, s.u1, "GET", `/api/materials/${id}/content`)).json().error, "delivery_not_done");
});

// --- Фаза 10, схождение (T076, T084, T085, T086, T089, T090) ---

test("T076: путь-каталог над путём другого Материала и под ним — 409 material_path_taken", async (t) => {
  const s = await stand(t);
  const data = syntheticBytes(10, "prefix");
  const reg = (path: string) => callAs(s.svc, s.u1, "POST", "/api/materials", materialRequest(s.svc.session(s.u1), { caseId: s.caseId, sha256: sha256Of(data), size: data.length }, { path }));
  assert.equal((await reg("a/b")).statusCode, 201);
  assert.equal((await reg("A")).json().error, "material_path_taken");
  assert.equal((await reg("a/b/c")).json().error, "material_path_taken");
  assert.equal((await reg("ab")).statusCode, 201, "общий префикс без «/» — не конфликт");
  assert.equal((await reg("x.zaverenie-1.json/y")).json().error, "material_path_reserved");
});

test("T084: отказы доставки — чужая Станция, держит другая, удалён — пишутся в журнал", async (t) => {
  const s = await stand(t);
  const data = syntheticBytes(300, "rejects");
  const id = await registered(s, data, { path: "j.img" });
  await put(s.svc, s.u1, id, 0, data.subarray(0, 100));
  await put(s.svc, s.u2, id, 100, data.subarray(100, 200));
  const { openTestSession } = await import("../../../../tests/support/harness.ts");
  const s3 = openTestSession(s.svc.db, s.u1);
  const heldReq = () => s.svc.rawInject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { "aristotel-api-version": "1", authorization: `Bearer ${s3.token}`, "content-type": "application/octet-stream", "aristotel-offset": "100" }, payload: Buffer.from(data.subarray(100, 200)) });
  const held = await heldReq();
  assert.ok(Number.isFinite(Date.parse(held.json().until)), "отказ несёт until (T091)");
  await heldReq();
  await heldReq();
  const version = Number(s.svc.db.prepare("SELECT version FROM record WHERE id = ?").get(id)?.["version"]);
  await callAs(s.svc, s.svc.seniorId, "POST", `/api/materials/${id}/delete`, { expectedVersion: version, reason: "x" });
  await put(s.svc, s.u1, id, 100, data.subarray(100, 200));
  const codes = s.svc.db.prepare("SELECT details FROM journal WHERE subjectId = ? AND action = 'material.deliver.reject' ORDER BY seq").all(id).map((r) => JSON.parse(String(r["details"])).code);
  assert.deepEqual(codes, ["delivery_station", "delivery_held", "material_deleted"]);
});

test("T085: перехват Старшим на непоследней части доходит до журнала доставки", async (t) => {
  const s = await stand(t);
  const data = syntheticBytes(300, "takeover");
  const id = await registered(s, data, { path: "t.img" });
  await put(s.svc, s.u1, id, 0, data.subarray(0, 100));
  assert.equal((await put(s.svc, s.svc.seniorId, id, 100, data.subarray(100, 200))).statusCode, 200);
  assert.equal((await put(s.svc, s.svc.seniorId, id, 200, data.subarray(200))).statusCode, 200);
  const details = JSON.parse(String(s.svc.db.prepare("SELECT details FROM journal WHERE subjectId = ? AND action = 'material.deliver'").get(id)?.["details"]));
  assert.equal(details.takenOverFrom, s.svc.session(s.u1).stationId);
});

test("T089, T090: отозванный держатель и брошенная (час без частей) доставка — другая Станция продолжает с принятого", async (t) => {
  const s = await stand(t);
  const { openTestSession } = await import("../../../../tests/support/harness.ts");
  const putAs = (token: string, id: string, offset: number, chunk: Uint8Array) =>
    s.svc.rawInject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { "aristotel-api-version": "1", authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "aristotel-offset": String(offset) }, payload: Buffer.from(chunk) });
  // Отозванный держатель.
  const data = syntheticBytes(200, "revoked-holder");
  const id = await registered(s, data, { path: "rv.img" });
  await put(s.svc, s.u1, id, 0, data.subarray(0, 100));
  s.svc.db.prepare("UPDATE station SET state = 'revoked' WHERE id = ?").run(s.svc.session(s.u1).stationId);
  const s3 = openTestSession(s.svc.db, s.u1);
  const cont = await putAs(s3.token, id, 100, data.subarray(100));
  assert.equal(cont.statusCode, 200, cont.body);
  assert.equal(cont.json().view.deliveredByStation, s3.stationId);
  // Брошенная: части не приходили больше часа.
  const other = syntheticBytes(200, "abandoned");
  // S1 отозвана — регистрирует S3 через свой сеанс.
  const reg = await s.svc.rawInject({
    method: "POST",
    url: "/api/materials",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${s3.token}`, "content-type": "application/json" },
    payload: materialRequest(s3, { caseId: s.caseId, sha256: sha256Of(other), size: other.length }, { path: "ab.img" }),
  });
  assert.equal(reg.statusCode, 201, reg.body);
  const id2 = reg.json().id as string;
  const s4 = openTestSession(s.svc.db, s.u1);
  assert.equal((await putAs(s3.token, id2, 0, other.subarray(0, 100))).statusCode, 200);
  assert.equal((await putAs(s4.token, id2, 100, other.subarray(100))).json().error, "delivery_held");
  s.svc.db.prepare("UPDATE material_upload SET updatedAt = ? WHERE materialId = ?").run(new Date(Date.now() - 2 * 3600_000).toISOString(), id2);
  const done = await putAs(s4.token, id2, 100, other.subarray(100));
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(JSON.parse(String(s.svc.db.prepare("SELECT details FROM journal WHERE subjectId = ? AND action = 'material.deliver'").get(id2)?.["details"])).takenOverFrom, s3.stationId);
});

test("T086: удаление во время приёма последней части — без 500; файла в дереве не остаётся", async (t) => {
  const s = await stand(t);
  const data = syntheticBytes(6 * 1024 * 1024, "race");
  const id = await registered(s, data, { path: "race.img" });
  const putting = put(s.svc, s.u1, id, 0, data);
  const deleting = callAs(s.svc, s.svc.seniorId, "POST", `/api/materials/${id}/delete`, { expectedVersion: 1, reason: "гонка" });
  const [p, d] = await Promise.all([putting, deleting]);
  assert.ok([200, 409].includes(p.statusCode), `${p.statusCode} ${p.body}`);
  assert.ok([200, 409].includes(d.statusCode), `${d.statusCode} ${d.body}`);
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (d.statusCode === 200) assert.equal(existsSync(join(s.svc.dir, "materials", "cases", s.caseId, "race.img")), false);
});
