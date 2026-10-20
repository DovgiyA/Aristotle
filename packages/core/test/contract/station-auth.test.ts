// T010 фичи 004 — API Станций: сеанс тестовой Станции, роль Члена Группы на каждом запросе,
// «только удаление», подтверждение присутствия (contracts/http-api.md «Общие правила»; STATION-10,
// STATION-12, STATION-22, ROLE-09; research R9, R10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  API_VERSION_HEADER,
  PRESENCE_HEADER,
  ed25519FromSeed,
  ed25519Sign,
  encodeBytes,
  encodePresenceHeader,
  presenceBodyText,
  presenceMessage,
  sha256Hex,
} from "@aristotel/protocol";
import { openTestSession, presenceHeaderFor, setRole, startTestService, type TestSession, type TestService } from "../../../../tests/support/harness.ts";

const headers = (session: TestSession, extra: Record<string, string> = {}) => ({
  [API_VERSION_HEADER]: "1",
  authorization: `Bearer ${session.token}`,
  "content-type": "application/json",
  ...extra,
});

/** Запрос без автоматического подтверждения присутствия стенда. */
function raw(svc: TestService, session: TestSession, method: "GET" | "POST", url: string, payload?: object, extra: Record<string, string> = {}) {
  return svc.rawInject({ method, url, headers: headers(session, extra), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

const CREATE = { label: "У3", role: "participant" };

test("сеанс тестовой Станции: автор и роль — её Члена Группы; смена роли — на следующем запросе (ROLE-09)", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const session = openTestSession(svc.db, u1);
  assert.equal((await raw(svc, session, "GET", "/api/members")).statusCode, 200);
  assert.equal((await raw(svc, session, "POST", "/api/members", CREATE, { [PRESENCE_HEADER]: presenceHeaderFor(session, "POST", "/api/members", CREATE) })).statusCode, 403);
  setRole(svc.db, u1, "senior");
  const res = await raw(svc, session, "POST", "/api/members", CREATE, { [PRESENCE_HEADER]: presenceHeaderFor(session, "POST", "/api/members", CREATE) });
  assert.equal(res.statusCode, 201, res.body);
});

test("Член Группы отозван — 403 member_revoked на любом запросе сеанса", async (t) => {
  const svc = await startTestService(t);
  const u1 = svc.addMember("У1");
  const session = openTestSession(svc.db, u1);
  svc.db.prepare("UPDATE member SET state = 'revoked', version = version + 1 WHERE id = ?").run(u1);
  const res = await raw(svc, session, "GET", "/api/members");
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "member_revoked");
});

test("сеанс «только удаление» — 403 station_delete_only на маршрутах Банка (STATION-22)", async (t) => {
  const svc = await startTestService(t);
  const session = openTestSession(svc.db, svc.seniorId, { scope: "delete-only" });
  svc.db
    .prepare("UPDATE station SET state = 'revoked', revokedAt = ?, revokeReason = 'revoked', deleteOnlyUntil = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), session.stationId);
  for (const url of ["/api/members", "/api/journal", "/api/registry"]) {
    const res = await raw(svc, session, "GET", url);
    assert.equal(res.statusCode, 403, url);
    assert.equal(res.json().error, "station_delete_only");
  }
});

test("действие с присутствием без заголовка — 403 presence_required до разбора тела", async (t) => {
  const svc = await startTestService(t);
  const session = svc.session(svc.seniorId);
  const res = await svc.rawInject({ method: "POST", url: "/api/members", headers: headers(session), payload: "{не json" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "presence_required");
  assert.match(res.json().message, /пароль/);
});

test("чужое, на другое действие, путь или тело, старое, повторное подтверждение — 403; верное — выполняется", async (t) => {
  const svc = await startTestService(t);
  const session = svc.session(svc.seniorId);
  const other = openTestSession(svc.db, svc.seniorId);
  const attempt = (presence: string, payload: object = CREATE, url = "/api/members") =>
    raw(svc, session, "POST", url, payload, { [PRESENCE_HEADER]: presence });
  const expectRefused = async (presence: string, label: string, payload?: object) => {
    const res = await attempt(presence, payload);
    assert.equal(res.statusCode, 403, label);
    assert.equal(res.json().error, "presence_required", label);
  };
  await expectRefused(presenceHeaderFor(other, "POST", "/api/members", CREATE), "другой сеанс");
  await expectRefused(presenceHeaderFor(session, "POST", "/api/members", { label: "У4", role: "participant" }), "другое тело");
  await expectRefused(presenceHeaderFor(session, "PATCH", "/api/members", CREATE), "другой метод");
  await expectRefused(presenceHeaderFor(session, "POST", "/api/records", CREATE), "другой путь");
  await expectRefused("не заголовок", "мусор");
  // Старше 60 с.
  const nonce = new Uint8Array(randomBytes(16));
  const issuedAt = new Date(Date.now() - 61_000).toISOString();
  const message = presenceMessage({ sessionId: session.sessionId, method: "POST", path: "/api/members", bodySha256: sha256Hex(presenceBodyText(CREATE)), issuedAt, nonce });
  await expectRefused(encodePresenceHeader({ issuedAt, nonce: encodeBytes(nonce), signature: encodeBytes(ed25519Sign(session.key, message)) }), "старое");
  // Подпись не тем ключом.
  const fresh = new Date().toISOString();
  const forged = presenceMessage({ sessionId: session.sessionId, method: "POST", path: "/api/members", bodySha256: sha256Hex(presenceBodyText(CREATE)), issuedAt: fresh, nonce });
  await expectRefused(
    encodePresenceHeader({ issuedAt: fresh, nonce: encodeBytes(nonce), signature: encodeBytes(ed25519Sign(ed25519FromSeed(new Uint8Array(32).fill(9)), forged)) }),
    "чужой ключ",
  );
  const good = presenceHeaderFor(session, "POST", "/api/members", CREATE);
  assert.equal((await attempt(good)).statusCode, 201);
  await expectRefused(good, "повтор nonce");
});

test("подтверждение, выданное до запуска службы, не принимается", async (t) => {
  const svc = await startTestService(t);
  const session = svc.session(svc.seniorId);
  const nonce = new Uint8Array(randomBytes(16));
  const issuedAt = new Date(Date.now() - 10_000).toISOString();
  // Служба стенда запущена только что: подтверждение «из прошлого запуска» старше её.
  const before = new Date(Date.parse(issuedAt) - 30_000).toISOString();
  const message = presenceMessage({ sessionId: session.sessionId, method: "POST", path: "/api/members", bodySha256: sha256Hex(presenceBodyText(CREATE)), issuedAt: before, nonce });
  const res = await raw(svc, session, "POST", "/api/members", CREATE, {
    [PRESENCE_HEADER]: encodePresenceHeader({ issuedAt: before, nonce: encodeBytes(nonce), signature: encodeBytes(ed25519Sign(session.key, message)) }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "presence_required");
});

test("действия без признака присутствия идут без заголовка: Запись, метка Секрет", async (t) => {
  const svc = await startTestService(t);
  const session = svc.session(svc.seniorId);
  const created = await raw(svc, session, "POST", "/api/records", { type: "test.note", fields: { x: "v" } });
  assert.equal(created.statusCode, 201);
});
