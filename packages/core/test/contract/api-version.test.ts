// T013 — версия API: GET /api/version без заголовков, 426 для несовместимой версии
// (APP-23; research R10; contracts/http-api.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestService } from "../../../../tests/support/harness.ts";

test("GET /api/version отвечает без заголовков (APP-23)", async (t) => {
  const svc = await startTestService(t);
  const res = await svc.app.inject({ method: "GET", url: "/api/version" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.apiVersions, [1]);
  assert.equal(body.role, "base-station");
  assert.equal(typeof body.programVersion, "string");
});

for (const [name, version] of [
  ["без заголовка версии", undefined],
  ["с версией 2", "2"],
] as const) {
  test(`запрос ${name} — 426 api_version_incompatible, запрос не исполняется (APP-23)`, async (t) => {
    const svc = await startTestService(t);
    let executed = false;
    svc.app.get("/api/test/ping", { config: { right: "journal.read" } }, async () => {
      executed = true;
      return { ok: true };
    });
    const headers: Record<string, string> = { ...svc.authHeaders(svc.seniorId) };
    if (version === undefined) delete headers["aristotel-api-version"];
    else headers["aristotel-api-version"] = version;
    const res = await svc.app.inject({ method: "GET", url: "/api/test/ping", headers });
    assert.equal(res.statusCode, 426);
    const body = res.json();
    assert.equal(body.error, "api_version_incompatible");
    assert.deepEqual(body.supported, [1]);
    assert.match(body.message, /Обновите программу/);
    assert.equal(executed, false);
  });
}
