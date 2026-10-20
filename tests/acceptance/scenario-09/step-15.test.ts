// T040 фичи 004 — сценарий 9, шаг 9.15: С2 отозван, а С1 потерял свою единственную Станцию — CLI на
// Опорной станции выпускает С1 Приглашение без Станции и без повторного ввода пароля, выпуск — в
// журнале; пока у другого Старшего есть действующая Станция, — отказ (STATION-43, STATION-14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { parseInvitation } from "@aristotel/protocol";
import { addMember, openTestSession, runCli } from "../../support/harness.ts";
import { acceptOnStand, invitationKnown, startNetwork, tempDir, waitFor } from "../../support/network.ts";

test("9.15: Приглашение С1 через CLI Опорной станции; у другого Старшего есть Станция — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const c2 = addMember(net.server.db, "С2", "senior");
  openTestSession(net.server.db, c2);
  const refused = await runCli(["invitation", "issue", "--senior", net.seniorId, "--data-dir", net.dir]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /другого Старшего есть действующая Станция/);
  // С2 отозван — его Станции тоже (STATION-18; здесь — прямо в БД, отзыв через API — US5).
  net.server.db.prepare("UPDATE station SET state = 'revoked', revokedAt = 't', revokeReason = 'member-revoked' WHERE memberId = ?").run(c2);
  net.server.db.prepare("UPDATE member SET state = 'revoked', version = version + 1 WHERE id = ?").run(c2);
  const out = join(tempDir(t), "priglashenie.txt");
  const issued = await runCli(["invitation", "issue", "--senior", net.seniorId, "--out", out, "--data-dir", net.dir]);
  assert.equal(issued.code, 0, issued.stderr);
  const text = readFileSync(out, "utf8");
  assert.ok(!issued.stdout.includes(text.trim()), "строка — только в файле");
  if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
  const entry = net.server.db.prepare("SELECT actorId, details FROM journal WHERE action = 'invitation.issue'").get()!;
  assert.equal(entry["actorId"], null);
  assert.equal(JSON.parse(String(entry["details"])).via, "cli");
  assert.ok(!String(entry["details"]).includes(parseInvitation(text).secret));
  await invitationKnown(net, text);
  const { result } = await acceptOnStand(t, text);
  assert.equal(result.memberId, net.seniorId);
});
