// T023 — SC-001: для каждого действия фичи, у которого есть маршрут, и каждой роли Группы A
// разрешённое выполняется, запрещённое отклоняется 403 forbidden без изменений и записи журнала;
// отозванному — 403 member_revoked на всё (ROLE-05, ROLE-07, ROLE-10 … ROLE-22, ROLE-36 — механизм;
// FR-005, FR-006, STATION-17; метка Секрет — ROLE-17, ROLE-18). Строки Сети фичи 003 — T040: Реестр,
// Ключ Группы и Ключи Координатора читают все (ROLE-37), черновик, применение и свой ключ — Старший
// (FR-010, research R12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinatorKeyProofMessage, type Action, type Role } from "@aristotel/protocol";
import { isAllowed } from "@aristotel/protocol";
import {
  callAs,
  countRows,
  groupA,
  insertCoordinatorKey,
  registryDocument,
  signDocument,
  startTestService,
  testCoordinatorKey,
  RELAY_X,
  type TestService,
} from "../../support/harness.ts";

interface Fixture {
  recordId: string;
  /** Секрет-Запись — для снятия метки. */
  secretId: string;
  target: string;
}

interface Case {
  action: Action;
  method: "GET" | "POST" | "PATCH";
  url: (f: Fixture) => string;
  /** Тело запроса; функция — когда оно зависит от Банка стенда или автора запроса. */
  payload?: unknown | ((svc: TestService, actorId: string) => unknown);
  /** Подготовка перед запросом — когда разрешённому действию нужно состояние (ключ у автора). */
  setup?: (svc: TestService, actorId: string) => void;
}

const K1 = testCoordinatorKey(1);

const CASES: Case[] = [
  { action: "record.read", method: "GET", url: (f) => `/api/records/${f.recordId}` },
  { action: "record.read", method: "GET", url: (f) => `/api/records/${f.recordId}/history` },
  { action: "record.create", method: "POST", url: () => "/api/records", payload: { type: "test.note", fields: { x: "v" } } },
  { action: "record.update", method: "PATCH", url: (f) => `/api/records/${f.recordId}`, payload: { expectedVersion: 1, fields: { x: "w" } } },
  { action: "record.secret.mark", method: "POST", url: (f) => `/api/records/${f.recordId}/secret/mark`, payload: { expectedVersion: 1 } },
  { action: "record.secret.unmark", method: "POST", url: (f) => `/api/records/${f.secretId}/secret/unmark`, payload: { expectedVersion: 1 } },
  { action: "journal.read", method: "GET", url: () => "/api/journal" },
  { action: "member.read", method: "GET", url: () => "/api/members" },
  { action: "member.read", method: "GET", url: (f) => `/api/members/${f.target}` },
  { action: "member.create", method: "POST", url: () => "/api/members", payload: { label: "У3", role: "participant" } },
  { action: "member.update", method: "PATCH", url: (f) => `/api/members/${f.target}`, payload: { expectedVersion: 1, role: "observer" } },
  { action: "member.revoke", method: "POST", url: (f) => `/api/members/${f.target}/revoke`, payload: { expectedVersion: 1 } },
  { action: "registry.read", method: "GET", url: () => "/api/group-key" },
  { action: "registry.read", method: "GET", url: () => "/api/registry" },
  { action: "registry.read", method: "GET", url: () => "/api/coordinator-keys" },
  { action: "registry.draft", method: "POST", url: () => "/api/registry/draft", payload: { code: "A", addRelays: [RELAY_X] } },
  {
    action: "registry.apply",
    method: "POST",
    url: () => "/api/registry/versions",
    payload: (svc: TestService) => signDocument(registryDocument(svc.db, { coordinatorKeys: [K1.publicKey] }), K1),
  },
  {
    action: "coordinator-key.register",
    method: "POST",
    url: () => "/api/coordinator-keys",
    payload: (svc: TestService, actorId: string) => {
      const key = testCoordinatorKey(7);
      const proof = Buffer.from(key.sign(coordinatorKeyProofMessage(svc.install.installId, actorId))).toString("base64").replace(/=+$/, "");
      return { publicKey: key.publicKey, proof };
    },
  },
  {
    action: "coordinator-key.withdraw",
    method: "POST",
    url: () => "/api/coordinator-keys/withdraw",
    payload: {},
    setup: (svc, actorId) => insertCoordinatorKey(svc.db, actorId, testCoordinatorKey(8).publicKey),
  },
];

const TABLES = ["member", "record", "record_history", "journal"] as const;
const NETWORK_TABLES = ["group_key", "coordinator_key", "registry_version", "registry_conflict"] as const;

function snapshot(svc: TestService): number[] {
  return [
    ...TABLES.map((table) => countRows(svc.db, table)),
    ...NETWORK_TABLES.map((table) => Number(svc.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"])),
  ];
}

function payloadOf(c: Case, svc: TestService, actorId: string): unknown {
  return typeof c.payload === "function" ? (c.payload as (svc: TestService, actorId: string) => unknown)(svc, actorId) : c.payload;
}

async function prepare(t: Parameters<typeof startTestService>[0]) {
  const svc = await startTestService(t);
  const a = groupA(svc.db, svc.seniorId);
  const created = await callAs(svc, a.c1, "POST", "/api/records", { type: "test.note", fields: { x: "v" } });
  const secret = await callAs(svc, a.c1, "POST", "/api/records", { type: "test.note", fields: { x: "w" }, secret: true });
  // Ключ Координатора С1 — для черновика и применения версии 1 Старшим (фича 003).
  insertCoordinatorKey(svc.db, a.c1, K1.publicKey);
  return { svc, a, fixture: { recordId: created.json().id as string, secretId: secret.json().id as string, target: a.u2 } };
}

const ACTORS: { name: string; role: Role; pick: (a: ReturnType<typeof groupA>) => string }[] = [
  { name: "Участник У1", role: "participant", pick: (a) => a.u1 },
  { name: "Старший С2", role: "senior", pick: (a) => a.c2! },
  { name: "Наблюдатель Н1", role: "observer", pick: (a) => a.n1 },
];

for (const actor of ACTORS) {
  test(`SC-001: ${actor.name} — каждое действие по таблице прав`, async (t) => {
    for (const c of CASES) {
      const { svc, a, fixture } = await prepare(t);
      const actorId = actor.pick(a);
      if (isAllowed(actor.role, c.action)) c.setup?.(svc, actorId);
      const before = snapshot(svc);
      const res = await callAs(svc, actorId, c.method, c.url(fixture), payloadOf(c, svc, actorId));
      const label = `${c.method} ${c.url(fixture)} (${c.action})`;
      if (isAllowed(actor.role, c.action)) {
        assert.ok(res.statusCode < 300, `${label}: ${res.statusCode} ${res.body}`);
      } else {
        assert.equal(res.statusCode, 403, label);
        assert.equal(res.json().error, "forbidden", label);
        assert.deepEqual(snapshot(svc), before, `${label}: изменений и записей журнала быть не должно`);
      }
    }
  });
}

test("SC-001: отозванному Члену Группы — 403 member_revoked на каждое действие", async (t) => {
  for (const c of CASES) {
    const { svc, a, fixture } = await prepare(t);
    await callAs(svc, a.c1, "POST", `/api/members/${a.u1}/revoke`, { expectedVersion: 1 });
    const before = snapshot(svc);
    const res = await callAs(svc, a.u1, c.method, c.url(fixture), payloadOf(c, svc, a.u1));
    assert.equal(res.statusCode, 403, c.action);
    assert.equal(res.json().error, "member_revoked", c.action);
    assert.deepEqual(snapshot(svc), before, c.action);
  }
});
