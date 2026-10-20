// T016 — в логах нет значений полей и параметров запроса (FR-013; research R14, конституция VII).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService } from "../../../../tests/support/harness.ts";

test("строка лога запроса — метод, путь без параметров, код ответа; без тела и параметров", async (t) => {
  const lines: string[] = [];
  const svc = await startTestService(t, { logStream: { write: (s: string) => void lines.push(s) } });
  svc.app.post("/api/test/echo/:id", { config: { right: "record.create" } }, async () => ({ ok: true }));
  const id = "0190d6a0-0000-7000-8000-000000000001";
  await svc.app.inject({
    method: "POST",
    url: `/api/test/echo/${id}?x=v-параметр`,
    headers: { ...svc.authHeaders(svc.seniorId), "content-type": "application/json" },
    payload: { x: "w-значение" },
  });
  const log = lines.join("\n");
  assert.match(log, /"method":"POST"/);
  assert.match(log, new RegExp(`"path":"/api/test/echo/${id}"`));
  assert.match(log, /"statusCode":200/);
  assert.doesNotMatch(log, /v-параметр/);
  assert.doesNotMatch(log, /w-значение/);
});

// T047 фичи 002 — новые маршруты: в логах нет подписей Членов Группы из тел запросов, значений полей
// Записей и Секрет-Записей (FR-012; конституция VII).
test("логи POST /api/members, PATCH Члена Группы и метки Секрет — без подписей и значений", async (t) => {
  const lines: string[] = [];
  const svc = await startTestService(t, { logStream: { write: (s: string) => void lines.push(s) } });
  const headers = { ...svc.authHeaders(svc.seniorId), "content-type": "application/json" };
  const created = (
    await svc.app.inject({ method: "POST", url: "/api/members", headers, payload: { label: "y-подпись", role: "participant" } })
  ).json();
  await svc.app.inject({ method: "PATCH", url: `/api/members/${created.id}`, headers, payload: { expectedVersion: 1, label: "z-подпись" } });
  const record = (
    await svc.app.inject({ method: "POST", url: "/api/records", headers, payload: { type: "test.note", fields: { x: "w-значение" }, secret: true } })
  ).json();
  await svc.app.inject({ method: "POST", url: `/api/records/${record.id}/secret/unmark`, headers, payload: { expectedVersion: 1 } });
  const log = lines.join("\n");
  assert.match(log, /"path":"\/api\/members"/);
  assert.match(log, /secret\/unmark/);
  for (const value of ["y-подпись", "z-подпись", "w-значение"]) assert.doesNotMatch(log, new RegExp(value));
});

// T057 фичи 003 — маршруты Сети: в логах нет тел запросов — документов Реестра, доказательств владения,
// открытых ключей и Кодов из тела (research R15; конституция VII; FR-013).
test("логи регистрации Ключа Координатора, черновика и применения версии — без тел запросов", async (t) => {
  const { coordinatorKeyProofMessage } = await import("@aristotel/protocol");
  const { registryDocument, signDocument, testCoordinatorKey, RELAY_X } = await import("../../../../tests/support/harness.ts");
  const lines: string[] = [];
  const svc = await startTestService(t, { logStream: { write: (s: string) => void lines.push(s) } });
  const headers = { ...svc.authHeaders(svc.seniorId), "content-type": "application/json" };
  const key = testCoordinatorKey(1);
  const proof = Buffer.from(key.sign(coordinatorKeyProofMessage(svc.install.installId, svc.seniorId))).toString("base64").replace(/=+$/, "");
  await svc.app.inject({ method: "POST", url: "/api/coordinator-keys", headers, payload: { publicKey: key.publicKey, proof } });
  await svc.app.inject({ method: "POST", url: "/api/registry/draft", headers, payload: { code: "K2", addRelays: [RELAY_X] } });
  const doc = signDocument(registryDocument(svc.db, { code: "K2", coordinatorKeys: [key.publicKey] }), key);
  await svc.app.inject({ method: "POST", url: "/api/registry/versions", headers, payload: doc as unknown as Record<string, unknown> });
  const log = lines.join("\n");
  assert.match(log, /"path":"\/api\/registry\/versions"/);
  assert.match(log, /"statusCode":201/);
  for (const value of [key.publicKey, proof, doc.signatures[0]!.sig, "relay-x.test", "\"K2\"", "K2\\\\"]) {
    assert.equal(log.includes(value), false, value);
  }
});
