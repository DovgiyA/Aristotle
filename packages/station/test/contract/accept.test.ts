// T039 фичи 004 — приём Станции через настоящий Проход: вызов Прохода ключом Прохода Приглашения,
// внутренний TLS со сверкой отпечатка, Ключ станции под паролем, station.json; чужой отпечаток —
// соединения нет, Приглашение не использовано (STATION-03, STATION-09, STATION-16; research R7, R13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeBytes, deriveInvitationKeys, parseInvitation } from "@aristotel/protocol";
import { ensureTlsKey, TlsMismatchError } from "@aristotel/core";
import { AcceptError, acceptInvitation, openStationKey, readStationState } from "../../src/index.ts";
import { TEST_STATION_PASSWORD, TEST_WORK_FACTOR, seniorInvitation, startNetwork, tempDir, waitFor } from "../../../../tests/support/network.ts";

test("приём через Проход: Ключ станции под паролем, station.json, Станция в БД, ключ в перечне Прохода", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const invitation = await seniorInvitation(net);
  const dir = tempDir(t, "aristotel-station-");
  // Перехват стенда: Ретранслятор видит только ключ Прохода, не секрет и не ключ приёма.
  const keys = deriveInvitationKeys(decodeBytes(parseInvitation(invitation).secret, 32)!);
  await waitFor(() => net.relays[0]!.server!.passages.listOf("A").some((e) => e.key === keys.passageKey), 3000, "ключ Прохода у Ретранслятора");
  const result = await acceptInvitation({ dataDir: dir, invitation, password: TEST_STATION_PASSWORD, workFactor: TEST_WORK_FACTOR });
  assert.equal(result.memberId, net.seniorId);
  assert.equal(result.role, "senior");
  const state = readStationState(dir);
  assert.deepEqual(Object.keys(state).sort(), ["acceptedAt", "baseInstallId", "baseTlsSpki", "code", "idleLockMinutes", "memberId", "memberLabel", "passages", "role", "stationId"]);
  assert.equal(state.baseTlsSpki, net.server.tls.tlsSpki);
  assert.deepEqual(state.passages, [net.relays[0]!.relay.url]);
  const keyFile = readFileSync(join(dir, "station-key.age"), "utf8");
  assert.match(keyFile, /BEGIN AGE ENCRYPTED FILE/);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "station-key.age")).mode & 0o777, 0o600);
  assert.equal((await openStationKey(dir, TEST_STATION_PASSWORD)).publicKey, result.stationKey);
  await assert.rejects(openStationKey(dir, "wrong-password-x"), /Неверный пароль/);
  const row = net.server.db.prepare("SELECT memberId, state, publicKey FROM station WHERE id = ?").get(result.stationId)!;
  assert.deepEqual([row["memberId"], row["state"], row["publicKey"]], [net.seniorId, "active", result.stationKey]);
  await waitFor(() => net.relays[0]!.server!.passages.listOf("A").some((e) => e.key === result.stationKey), 3000, "Ключ станции в перечне Прохода");
  assert.ok(!net.relays[0]!.server!.passages.listOf("A").some((e) => e.key === keys.passageKey));
  const logs = net.relays[0]!.logs.join("");
  assert.ok(!logs.includes(parseInvitation(invitation).secret));
});

test("пароль короче 12 знаков — отказ, файлов нет", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  const dir = tempDir(t, "aristotel-station-");
  await assert.rejects(acceptInvitation({ dataDir: dir, invitation: await seniorInvitation(net), password: "short", workFactor: TEST_WORK_FACTOR }), (e: unknown) => (e as AcceptError).code === "password_weak");
  assert.equal(existsSync(join(dir, "station-key.age")), false);
});

test("TLS-отпечаток Опорной станции не тот, что в Приглашении — Станция рвёт соединение, Приглашение не использовано", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const invitation = await seniorInvitation(net);
  // Опорная станция перезапущена с другим TLS-ключом (подмена или восстановление — STATION-35, фича 015).
  await net.server.close();
  // Ретранслятор должен увидеть конец прежнего управляющего соединения, иначе вызов уйдёт в него.
  await waitFor(() => !net.relays[0]!.server!.passages.hasControl("A"), 5000, "прежнее соединение закрыто");
  rmSync(join(net.dir, "tls-key.pem"));
  rmSync(join(net.dir, "tls-cert.pem"));
  const fresh = ensureTlsKey(net.dir);
  const { startServer } = await import("@aristotel/core");
  const { FAST_RELAY_TIMERS } = await import("../../../../tests/support/network.ts");
  const server = await startServer({ dataDir: net.dir, relayTimers: FAST_RELAY_TIMERS });
  t.after(() => server.close());
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"), 5000, "вход после перезапуска");
  const dir = tempDir(t, "aristotel-station-");
  await assert.rejects(acceptInvitation({ dataDir: dir, invitation, password: TEST_STATION_PASSWORD, workFactor: TEST_WORK_FACTOR }), (error: unknown) => {
    assert.ok(error instanceof TlsMismatchError);
    assert.equal(error.expected, parseInvitation(invitation).baseTlsSpki);
    assert.equal(error.seen, fresh.tlsSpki);
    return true;
  });
  assert.equal(server.db.prepare("SELECT state FROM invitation WHERE id = ?").get(parseInvitation(invitation).invitationId)?.["state"], "issued");
  assert.equal(existsSync(join(dir, "station-key.age")), false);
});
