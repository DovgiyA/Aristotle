// T043 — история 3 фичи 006: Опорная станция проверяет Заверение (STATION-29, STATION-31, SC-001):
// отказы по каждой строке таблицы проверки с записью в журнал; отозванная и неизвестная Станция —
// повторное Заверение действующей Станцией загружающего, прежнее — с пометкой; все Заверения рядом с
// файлом (Clarifications); пометка — по состоянию Станции при показе; часы Станции не сверяются.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { ed25519FromSeed, publicKeyText } from "@aristotel/protocol";
import { callAs, openTestSession, startTestService, type TestService } from "../../support/harness.ts";
import { applyTestDictionary, createTestCase } from "../../support/dictionary.ts";
import { attestAs, materialRequest, sha256Of, syntheticBytes } from "../../support/materials.ts";

async function stand(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const caseId = (await createTestCase(svc, u1)).id;
  return { svc, u1, caseId };
}

const data = syntheticBytes(500, "attestation");
const facts = (caseId: string, id = randomUUIDv7()) => ({ id, caseId, sha256: sha256Of(data), size: data.length });

/** Станция, которой Банк не знает: ключ из семени, Идентификатор новый. */
function unknownStation(seed: number) {
  const key = ed25519FromSeed(new Uint8Array(32).fill(seed));
  return { stationId: randomUUIDv7(), key, publicKey: publicKeyText(key) };
}

async function put(svc: TestService, member: string, id: string, chunk: Uint8Array) {
  return await svc.app.inject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...svc.authHeaders(member), "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: Buffer.from(chunk) });
}

test("отозванная и неизвестная Станция без повторного Заверения — 409 и запись в журнал", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const s2 = openTestSession(svc.db, u1);
  svc.db.prepare("UPDATE station SET state = 'revoked' WHERE id = ?").run(s2.stationId);
  const f = facts(caseId);
  const fromRevoked = materialRequest(svc.session(u1), f, { attestation: attestAs(s2, f) });
  const revoked = await callAs(svc, u1, "POST", "/api/materials", fromRevoked);
  assert.equal(revoked.statusCode, 409);
  assert.equal(revoked.json().error, "attestation_station_revoked");
  const ghost = unknownStation(3);
  const g = facts(caseId);
  const fromUnknown = materialRequest(svc.session(u1), g, { attestation: attestAs(ghost, g) });
  const unknown = await callAs(svc, u1, "POST", "/api/materials", fromUnknown);
  assert.equal(unknown.statusCode, 409);
  assert.equal(unknown.json().error, "attestation_station_unknown");
  const codes = svc.db.prepare("SELECT details FROM journal WHERE action = 'material.attestation.reject' ORDER BY seq").all().map((r) => JSON.parse(String(r["details"])).code);
  assert.deepEqual(codes, ["attestation_station_revoked", "attestation_station_unknown"]);
});

test("повторное Заверение: Запись с прежним и новым Заверением; пометки; оба файла рядом после доставки", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const s2 = openTestSession(svc.db, u1);
  svc.db.prepare("UPDATE station SET state = 'revoked' WHERE id = ?").run(s2.stationId);
  const ghost = unknownStation(4);
  for (const [who, mark, path] of [[s2, "station_revoked", "a.img"], [ghost, "station_unknown", "b.img"]] as const) {
    const f = facts(caseId);
    const previous = attestAs(who, f);
    const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), f, { path, previousAttestations: [previous] }));
    assert.equal(res.statusCode, 201, res.body);
    const view = res.json().view as { attestations: { n: number; mark: string | null; current: boolean }[] };
    assert.deepEqual(view.attestations.map((a) => [a.n, a.mark, a.current]), [[1, mark, false], [2, null, true]]);
    const journal = JSON.parse(String(svc.db.prepare("SELECT details FROM journal WHERE subjectId = ? AND action = 'material.register'").get(f.id)?.["details"]));
    assert.equal(journal.reattested, 2);
    assert.equal((await put(svc, u1, f.id, data)).statusCode, 200);
    const file = join(svc.dir, "materials", "cases", caseId, path);
    assert.ok(existsSync(`${file}.zaverenie-1.json`) && existsSync(`${file}.zaverenie-2.json`));
    assert.equal(JSON.parse(readFileSync(`${file}.zaverenie-1.json`, "utf8")).station, who.stationId);
  }
});

test("повторное Заверение при действующей прежней Станции — 409; прежнее с другим хэшем — 422", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const s2 = openTestSession(svc.db, u1);
  const f = facts(caseId);
  const valid = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), f, { previousAttestations: [attestAs(s2, f)] }));
  assert.equal(valid.json().error, "attestation_previous_valid");
  const ghost = unknownStation(5);
  const other = attestAs(ghost, { ...f, sha256: "0".repeat(64) });
  const mismatch = await callAs(svc, u1, "POST", "/api/materials", materialRequest(svc.session(u1), f, { previousAttestations: [other] }));
  assert.equal(mismatch.statusCode, 422);
  assert.equal(mismatch.json().error, "attestation_mismatch");
});

test("отзыв Станции после регистрации меняет пометку при показе, Запись остаётся; часы Станции не сверяются", async (t) => {
  const { svc, u1, caseId } = await stand(t);
  const session = svc.session(u1);
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const res = await callAs(svc, u1, "POST", "/api/materials", materialRequest(session, { ...facts(caseId), at: dayAgo }));
  assert.equal(res.statusCode, 201, res.body);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await callAs(svc, u1, "POST", "/api/materials", materialRequest(session, { ...facts(caseId), at: tomorrow }, { path: "t.img" }))).statusCode, 201);
  const id = res.json().id as string;
  svc.db.prepare("UPDATE station SET state = 'revoked' WHERE id = ?").run(session.stationId);
  const c1 = svc.seniorId;
  const shown = await callAs(svc, c1, "GET", `/api/materials/${id}`);
  assert.equal(shown.statusCode, 200);
  assert.equal(shown.json().view.attestations[0].mark, "station_revoked");
  assert.equal(shown.json().view.attestations[0].at, dayAgo);
});
