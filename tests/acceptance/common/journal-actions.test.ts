// Словарь видов записей журнала (INBOX-32): фильтр интерфейса предлагает виды из JOURNAL_ACTIONS,
// поэтому каждый вид, который служба пишет при прогоне историй фич 001–004, должен в нём быть.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOURNAL_ACTIONS } from "@aristotel/protocol";
import { addMember } from "../../support/harness.ts";
import { callStation, startNetwork, startStation, waitFor } from "../../support/network.ts";

test("все виды записей журнала прогона — в словаре JOURNAL_ACTIONS", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const u1 = addMember(net.server.db, "У1");
  const s1 = await startStation(t, net, u1);
  const record = await s1.local("POST", "/api/records", { type: "test.note", fields: { x: "v" } });
  const id = String(record.body["id"]);
  await s1.local("PATCH", `/api/records/${id}`, { expectedVersion: 1, fields: { x: "w" } });
  await callStation(net, net.seniorId, "POST", `/api/records/${id}/secret/mark`, { expectedVersion: 2 });
  await callStation(net, net.seniorId, "POST", `/api/records/${id}/secret/unmark`, { expectedVersion: 3 });
  const u2 = String((await callStation(net, net.seniorId, "POST", "/api/members", { label: "У2", role: "participant" })).json().id);
  await callStation(net, net.seniorId, "PATCH", `/api/members/${u2}`, { expectedVersion: 1, label: "У2-а" });
  const inv = (await callStation(net, net.seniorId, "POST", "/api/invitations", { memberId: u2 })).json();
  await callStation(net, net.seniorId, "POST", `/api/invitations/${String(inv.id)}/cancel`, {});
  await callStation(net, net.seniorId, "PATCH", "/api/group-settings", { deleteOnlyDays: 30 });
  await callStation(net, net.seniorId, "POST", `/api/stations/${s1.result.stationId}/revoke`, { reason: "handover" });
  await waitFor(() => s1.server.part.deleted, 10_000, "сдача завершена");
  await callStation(net, net.seniorId, "POST", `/api/members/${u2}/revoke`, { expectedVersion: 2 });
  await net.publish([net.relays[0]!.relay]);
  const actions = net.server.db.prepare("SELECT DISTINCT action FROM journal").all().map((r) => String(r["action"]));
  const unknown = actions.filter((a) => !(JOURNAL_ACTIONS as readonly string[]).includes(a));
  assert.deepEqual(unknown, []);
  assert.ok(actions.length >= 15, actions.join(", "));
});

// Фича 005, T076: девять новых видов журнала встречаются в прогоне и есть в словаре.
test("виды журнала фичи 005 — в словаре JOURNAL_ACTIONS и встречаются в прогоне", async (t) => {
  const { startTestService, callAs, callMaintenance } = await import("../../support/harness.ts");
  const { T, applyTestDictionary, nextTestVersion, proposeLocal, signWithTestCoordinator } = await import("../../support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  await callMaintenance(svc, "POST", "/api/dictionary/versions", signWithTestCoordinator(nextTestVersion(v1, (b) => (b.previousSha256 = "0".repeat(64)))));
  await callMaintenance(svc, "POST", "/api/dictionary/versions", signWithTestCoordinator(nextTestVersion(nextTestVersion(v1, () => {}), () => {})));
  await callMaintenance(svc, "POST", "/api/dictionary/versions", signWithTestCoordinator({ ...v1, body: v1.body.replace('"issuedAt":"2026', '"issuedAt":"2025') }));
  await proposeLocal(svc, u1, "override", { element: T.indicator("ip"), property: "identifying", value: "loose" });
  const row = await proposeLocal(svc, u1, "stop_list_entry", { type: T.indicator("username"), kind: "value", value: "x", note: "п" });
  await proposeLocal(svc, u1, "stop_list_entry", { remove: row.json().resultId });
  const p = (await callAs(svc, u1, "POST", "/api/local-extension/proposals", { kind: "enum_value", payload: { enum: "os_distro", code: "x", label: "x" } })).json();
  await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.id}/reject`, { reason: "x" });
  const actions = svc.db.prepare("SELECT DISTINCT action FROM journal").all().map((r) => String(r["action"]));
  const expected = [
    "dictionary.apply",
    "dictionary.reject",
    "dictionary.conflict",
    "local-extension.propose",
    "local-extension.accept",
    "local-extension.reject",
    "local-extension.change",
    "stop-list.local.add",
    "stop-list.local.remove",
  ];
  for (const a of expected) assert.ok(actions.includes(a), a);
  assert.deepEqual(actions.filter((a) => !(JOURNAL_ACTIONS as readonly string[]).includes(a)), []);
});

// Фича 006, T071: семь видов журнала Материалов встречаются в прогоне, есть в словаре и видны в
// фильтре по Кейсу (INBOX-30, INBOX-32).
test("виды журнала фичи 006 — в словаре JOURNAL_ACTIONS и в фильтре по Кейсу", async (t) => {
  const { startTestService, callAs } = await import("../../support/harness.ts");
  const { applyTestDictionary, createTestCase } = await import("../../support/dictionary.ts");
  const { attestAs, materialRequest, sha256Of, syntheticBytes } = await import("../../support/materials.ts");
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const caseId = (await createTestCase(svc, u1)).id;
  const bytes = syntheticBytes(32, "journal");
  const facts = { caseId, sha256: sha256Of(bytes), size: bytes.length };
  const body = materialRequest(svc.session(u1), facts, { kind: "image" });
  const id = String((await callAs(svc, u1, "POST", "/api/materials", body)).json().id);
  // Отказ Заверения: подпись не сходится.
  const bad = materialRequest(svc.session(u1), facts);
  bad["attestation"] = { ...attestAs(svc.session(u1), { ...facts, id: String(bad["id"]) }), size: "1" };
  await callAs(svc, u1, "POST", "/api/materials", bad);
  const put = (data: Uint8Array) =>
    svc.app.inject({ method: "PUT", url: `/api/materials/${id}/content`, headers: { ...svc.authHeaders(u1), "content-type": "application/octet-stream", "aristotel-offset": "0" }, payload: Buffer.from(data) });
  await put(syntheticBytes(32, "другое"));
  const delivered = await put(bytes);
  const version = delivered.json().version as number;
  const set = await callAs(svc, u1, "POST", `/api/materials/${id}/kind`, { expectedVersion: version, kind: "logical_copy" });
  const released = await callAs(svc, svc.seniorId, "POST", `/api/materials/${id}/kind/release`, { expectedVersion: set.json().version, kind: "photo" });
  await callAs(svc, svc.seniorId, "POST", `/api/materials/${id}/delete`, { expectedVersion: released.json().version, reason: "дубль" });
  const kinds = ["material.register", "material.attestation.reject", "material.deliver", "material.deliver.reject", "material.kind.set", "material.kind.release", "material.delete"];
  const actions = svc.db.prepare("SELECT DISTINCT action FROM journal WHERE action LIKE 'material.%'").all().map((r) => String(r["action"]));
  assert.deepEqual(actions.sort(), [...kinds].sort());
  for (const kind of kinds) assert.ok((JOURNAL_ACTIONS as readonly string[]).includes(kind), kind);
  const byCase = await callAs(svc, svc.seniorId, "GET", `/api/journal?case=${caseId}&limit=1000`);
  const inCase = new Set((byCase.json().items as { action: string }[]).map((i) => i.action));
  for (const kind of kinds) assert.ok(inCase.has(kind), `${kind} в фильтре по Кейсу`);
});

