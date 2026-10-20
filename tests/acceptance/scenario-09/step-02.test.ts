// T040 фичи 004 — сценарий 9, шаг 9.2: С1 выпускает Приглашение для У3 — с повторным вводом пароля;
// одноразовая строка со сроком около 72 часов: Проходы, отпечаток TLS Опорной станции, секрет; в
// журнале — без секрета (STATION-12, STATION-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvitation } from "@aristotel/protocol";
import { callAs, launchTestNetwork, startTestService, RELAY_X } from "../../support/harness.ts";

test("9.2: Приглашение — с подтверждением присутствия; строка несёт Проходы, отпечаток TLS, секрет, срок", async (t) => {
  const svc = await startTestService(t);
  launchTestNetwork(svc);
  const u3 = svc.addMember("У3");
  const session = svc.session(svc.seniorId);
  const without = await svc.rawInject({
    method: "POST",
    url: "/api/invitations",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    payload: { memberId: u3 },
  });
  assert.equal(without.json().error, "presence_required");
  const res = await callAs(svc, svc.seniorId, "POST", "/api/invitations", { memberId: u3 });
  assert.equal(res.statusCode, 201);
  const inv = parseInvitation(res.json().invitation);
  assert.deepEqual(inv.passages, [RELAY_X.url]);
  assert.ok(inv.baseTlsSpki.length === 43 && inv.secret.length === 43);
  const hours = (Date.parse(inv.expiresAt) - Date.now()) / 3600_000;
  assert.ok(hours > 71 && hours <= 72);
  const journal = svc.db.prepare("SELECT details FROM journal WHERE action = 'invitation.issue'").all().map((r) => String(r["details"]));
  assert.equal(journal.length, 1);
  assert.ok(!journal[0]!.includes(inv.secret));
});
