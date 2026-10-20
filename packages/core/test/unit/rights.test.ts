// T003 фичи 002, T008 фичи 004 — одно правило прав: таблица «действие → роли» и признак присутствия
// по data-model.md «Права», свойство ROLE-05, каждый маршрут объявляет своё действие (FR-005;
// research R1 фичи 002; STATION-12, research R10, R15 фичи 004). Таблица — в protocol.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, RIGHTS, ROLES, needsPresence } from "@aristotel/protocol";
import { startTestService } from "../../../../tests/support/harness.ts";

const EXPECTED: Record<string, string[]> = {
  "record.read": ["participant", "senior", "observer"],
  "record.create": ["participant", "senior"],
  "record.update": ["participant", "senior"],
  "record.secret.mark": ["participant", "senior"],
  "record.secret.unmark": ["senior"],
  "journal.read": ["participant", "senior", "observer"],
  "member.read": ["participant", "senior", "observer"],
  "member.create": ["senior"],
  "member.update": ["senior"],
  "member.revoke": ["senior"],
  // Фича 003 (T005; data-model.md «Права»; ROLE-37, NET-13, FR-010, research R12).
  "registry.read": ["participant", "senior", "observer"],
  "registry.draft": ["senior"],
  "registry.apply": ["senior"],
  "coordinator-key.register": ["senior"],
  "coordinator-key.withdraw": ["senior"],
  // Фича 004 (T008; VIEW-47, STATION-13, STATION-17, STATION-44).
  "station.read": ["senior"],
  "station.revoke": ["senior"],
  "invitation.read": ["senior"],
  "invitation.issue": ["senior"],
  "invitation.cancel": ["senior"],
  "group-setting.update": ["senior"],
  // Фича 005 (T009; data-model.md «Права»; DICT-05, DICT-16, STATION-12).
  "dictionary.read": ["participant", "senior", "observer"],
  "dictionary.apply": ["senior"],
  "local-extension.propose": ["participant", "senior"],
  "local-extension.decide": ["senior"],
  // Фича 006 (T007; data-model.md «Права»; BANK-12, BANK-17, BANK-19, BANK-62, STATION-21).
  "material.register": ["participant", "senior"],
  "material.deliver": ["participant", "senior"],
  "material.kind.set": ["participant", "senior"],
  "material.kind.release": ["senior"],
  "material.delete": ["senior"],
  "material.station-list": ["senior"],
};

/** Подтверждение присутствия (STATION-12): ровно эти виды действий; отзыв и отмена — без него. */
const PRESENCE = [
  "member.create",
  "member.update",
  "member.revoke",
  "record.secret.unmark",
  "invitation.issue",
  "registry.apply",
  "coordinator-key.register",
  "dictionary.apply",
  "material.kind.release",
];

test("строки RIGHTS — ровно по таблице прав data-model.md", () => {
  assert.deepEqual([...ACTIONS].sort(), Object.keys(EXPECTED).sort());
  for (const action of ACTIONS) {
    assert.deepEqual([...RIGHTS[action].roles].sort(), [...(EXPECTED[action] ?? [])].sort(), action);
  }
  assert.deepEqual([...ROLES].sort(), ["observer", "participant", "senior"]);
});

test("ROLE-05: Старшему разрешено всё, что Участнику", () => {
  for (const action of ACTIONS) {
    if (RIGHTS[action].roles.includes("participant")) assert.ok(RIGHTS[action].roles.includes("senior"), action);
  }
});

test("STATION-12: признак присутствия — ровно у перечня; у отзыва Станции и отмены Приглашения его нет", () => {
  assert.deepEqual(ACTIONS.filter((a) => needsPresence(a)).sort(), [...PRESENCE].sort());
  assert.equal(needsPresence("station.revoke"), false);
  assert.equal(needsPresence("invitation.cancel"), false);
  // Удаления Материала нет в закрытом перечне STATION-12 (фича 006).
  assert.equal(needsPresence("material.delete"), false);
});

test("маршрут без config.right — ошибка запуска", async (t) => {
  const svc = await startTestService(t);
  assert.throws(() => svc.app.get("/api/test/no-right", async () => ({ ok: true })), /право/);
});

test("маршрут с видом действия не из RIGHTS — ошибка запуска", async (t) => {
  const svc = await startTestService(t);
  assert.throws(
    () => svc.app.get("/api/test/bad-right", { config: { right: "record.delete" as never } }, async () => ({ ok: true })),
    /право/,
  );
});

test("маршрут с правом из RIGHTS регистрируется", async (t) => {
  const svc = await startTestService(t);
  svc.app.get("/api/test/ok-right", { config: { right: "journal.read" } }, async () => ({ ok: true }));
  const res = await svc.app.inject({ method: "GET", url: "/api/test/ok-right", headers: svc.authHeaders(svc.seniorId) });
  assert.equal(res.statusCode, 200);
});
