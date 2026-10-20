// T041 фичи 003 — SC-002: после запуска Сети, регистрации двух Ключей Координатора и отказов ни один
// ответ API любой роли, ни файлы БД, ни журнал, ни логи службы и CLI не содержат секретных частей
// Ключа Группы и Ключей Координатора, паролей и путей к файлам ключей (FR-002, NET-02, NET-14;
// research R15).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coordinatorKeyProofMessage, decodeBytes, deriveInvitationKeys, encodeBytes, parseInvitation } from "@aristotel/protocol";
import { STATION_KEY_FORMAT, groupKeyPath, openKeyText } from "@aristotel/core";
import { stationKeyPath } from "@aristotel/station";
import { readKeyFile } from "../../../packages/cli/src/key-file.ts";
import {
  RELAY_X,
  TEST_KEY_PASSWORD,
  callAs,
  emptyDataDir,
  groupA,
  runCli,
  startTestService,
  writeCoordinatorKeyFile,
  writePasswordFile,
} from "../../support/harness.ts";
import { addMember } from "../../support/harness.ts";
import { TEST_STATION_PASSWORD, acceptOnStand, invitationKnown, startNetwork, startStation, uiLogin, waitFor } from "../../support/network.ts";

test("SC-002: секретов нет ни в ответах, ни в БД, ни в журнале, ни в логах", async (t) => {
  const log: string[] = [];
  const svc = await startTestService(t, { logStream: { write: (line) => void log.push(line) } });
  const a = groupA(svc.db, svc.seniorId);
  const usb = emptyDataDir(t);
  const responses: string[] = [];
  const call = async (who: string, method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await callAs(svc, who, method, url, payload);
    responses.push(res.body);
    return res;
  };

  const keyPaths = [join(usb, "c1.key"), join(usb, "c2.key")];
  const secrets: string[] = [TEST_KEY_PASSWORD, ...keyPaths];
  for (const [i, who] of [a.c1, a.c2 as string].entries()) {
    await writeCoordinatorKeyFile(keyPaths[i]!, svc.dir);
    const key = await readKeyFile(keyPaths[i]!, TEST_KEY_PASSWORD);
    secrets.push(key.pkcs8, Buffer.from(key.pkcs8, "base64").toString("hex"));
    const proof = Buffer.from(key.sign(coordinatorKeyProofMessage(svc.install.installId, who))).toString("base64").replace(/=+$/, "");
    assert.equal((await call(who, "POST", "/api/coordinator-keys", { publicKey: key.publicKey, proof })).statusCode, 201);
  }
  const groupFile = JSON.parse(readFileSync(groupKeyPath(svc.dir), "utf8"));
  secrets.push(groupFile.signing.pkcs8, groupFile.encryption.identity, Buffer.from(groupFile.signing.pkcs8, "base64").toString("hex"));

  // Черновик, подпись CLI без службы, применение; отказы.
  const draft = (await call(a.c1, "POST", "/api/registry/draft", { code: "A", addRelays: [RELAY_X] })).json();
  const draftPath = join(usb, "v1.draft.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(draftPath, JSON.stringify(draft));
  const pw = writePasswordFile(join(usb, "pw.txt"));
  const signedPath = join(usb, "v1.json");
  const cliRuns = [
    await runCli(["registry", "sign", draftPath, "--key", keyPaths[0]!, "--password-file", pw, "--out", signedPath, "--yes"]),
    await runCli(["coordinator-key", "show", keyPaths[1]!, "--password-file", pw]),
    await runCli(["coordinator-key", "show", keyPaths[1]!, "--password-file", writePasswordFile(join(usb, "bad.txt"), "test-password-wrong")]),
  ];
  const signed = JSON.parse(readFileSync(signedPath, "utf8"));
  await call(a.c1, "POST", "/api/registry/versions", { ...signed, signatures: [] });
  assert.equal((await call(a.c1, "POST", "/api/registry/versions", signed)).statusCode, 201);
  await call(a.u1, "POST", "/api/registry/versions", signed);

  for (const who of [a.c1, a.u1, a.n1]) {
    for (const url of ["/api/group-key", "/api/registry", "/api/coordinator-keys", "/api/registry/versions/1", "/api/journal", "/api/members"]) {
      await call(who, "GET", url);
    }
  }

  const sources: [string, Buffer][] = [
    ["ответы API", Buffer.from(responses.join("\n"))],
    ["журнал", Buffer.from(JSON.stringify(svc.db.prepare("SELECT * FROM journal").all()))],
    ["логи службы", Buffer.from(log.join(""))],
    ["вывод CLI", Buffer.from(cliRuns.map((r) => r.stdout + r.stderr).join("\n"))],
  ];
  for (const name of ["bank.sqlite", "bank.sqlite-wal", "bank.sqlite-shm"]) {
    const path = join(svc.dir, name);
    if (existsSync(path)) sources.push([name, readFileSync(path)]);
  }
  for (const [name, bytes] of sources) {
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `${name}: найден секрет`);
  }
  // Секрет-строки идентичности age нет нигде, кроме её файла.
  for (const [name, bytes] of sources) assert.equal(bytes.includes(Buffer.from("AGE-SECRET-KEY-1")), false, name);
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));
}

/** Ключ PEM: тело base64 и DER в hex — так секрет выглядел бы в чужом месте. */
function pemForms(path: string): string[] {
  const pem = readFileSync(path, "utf8");
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return [body.slice(0, 64), Buffer.from(body, "base64").toString("hex")];
}

test("SC-004 фичи 004: пароли, Ключи станций, секреты Приглашений, токены, TLS-ключи — нигде; адресов в журнале нет", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const c1 = await startStation(t, net);
  // Свой токен запуска — как aristotel open, чтобы знать его значение.
  const launch = "launch-token-secret-0123456789abcdef";
  writeFileSync(join(c1.dir, "launch-token"), JSON.stringify({ token: launch, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
  const base = `http://127.0.0.1:${c1.server.port}`;
  assert.equal((await fetch(`${base}/local/ui-session`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ launchToken: launch }) })).status, 200);
  const ui = await uiLogin(c1);
  const responses: string[] = [];
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const res = await ui.call(method, path, body, headers);
    responses.push(res.text);
    return res;
  };
  const presence = async (method: string, path: string, body: unknown) =>
    String((await call("POST", "/local/presence", { password: TEST_STATION_PASSWORD, method, path, body })).body["presence"]);

  // Выпуск Приглашения У2 в интерфейсе: строка — только в этом ответе.
  const u1 = addMember(net.server.db, "У1");
  const u2 = addMember(net.server.db, "У2");
  const issueBody = { memberId: u2 };
  const issued = await ui.call("POST", "/api/invitations", issueBody, { "aristotel-presence": await presence("POST", "/api/invitations", issueBody) });
  assert.equal(issued.status, 201, issued.text);
  const invitation = String(issued.body["invitation"]);
  await invitationKnown(net, invitation);
  const accepted = await acceptOnStand(t, invitation);
  const s1 = await startStation(t, net, u1);
  assert.equal((await s1.local("POST", "/api/records", { type: "test.note", fields: { x: "v" } })).status, 201);
  await call("POST", "/api/members", { label: "У3", role: "participant" }, { "aristotel-presence": await presence("POST", "/api/members", { label: "У3", role: "participant" }) });
  for (const path of ["/local/state", "/api/members", "/api/stations", "/api/invitations", "/api/journal", "/api/registry", "/api/group-settings"]) await call("GET", path);

  const secrets: string[] = [TEST_STATION_PASSWORD, launch, ui.csrf, ui.cookie.split("=")[1]!.split(";")[0]!];
  for (const station of [c1, s1]) secrets.push(station.server.part.session!.token);
  for (const dir of [c1.dir, s1.dir, accepted.dir]) {
    const opened = await openKeyText(readFileSync(stationKeyPath(dir), "utf8"), TEST_STATION_PASSWORD, STATION_KEY_FORMAT);
    secrets.push(opened.pkcs8, Buffer.from(opened.pkcs8, "base64").toString("hex"));
  }
  const parsed = parseInvitation(invitation);
  const keys = deriveInvitationKeys(decodeBytes(parsed.secret, 32)!);
  secrets.push(parsed.secret, encodeBytes(keys.acceptKey));
  secrets.push(...pemForms(join(net.dir, "tls-key.pem")), ...pemForms(join(net.relays[0]!.dir, "tls-key.pem")));

  // Сдача S1 в интерфейсе — её ключ удаляется.
  await call("POST", `/api/stations/${s1.result.stationId}/revoke`, { reason: "handover" });
  await waitFor(() => s1.server.part.deleted, 10_000, "сдача завершена");

  // Логи действительно собраны — иначе проверка ниже пуста.
  assert.ok(net.logs.length > 0 && net.relays[0]!.logs.length > 0 && c1.logs.length > 0, "логи прогона");
  const sources: [string, Buffer][] = [
    ["ответы API интерфейса", Buffer.from(responses.join("\n"))],
    ["журнал", Buffer.from(JSON.stringify(net.server.db.prepare("SELECT * FROM journal").all()))],
    ["логи службы", Buffer.from(net.logs.join(""))],
    ["логи Ретранслятора", Buffer.from(net.relays[0]!.logs.join(""))],
    ["логи локальных частей", Buffer.from([...c1.logs, ...s1.logs].join(""))],
  ];
  for (const name of ["bank.sqlite", "bank.sqlite-wal", "bank.sqlite-shm"]) {
    const path = join(net.dir, name);
    if (existsSync(path)) sources.push([name, readFileSync(path)]);
  }
  for (const file of filesUnder(net.relays[0]!.dir)) if (!file.endsWith("tls-key.pem")) sources.push([`Ретранслятор: ${file}`, readFileSync(file)]);
  for (const [name, bytes] of sources) {
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `${name}: найден секрет ${secret.slice(0, 8)}…`);
    assert.equal(bytes.includes(Buffer.from(invitation)), false, `${name}: строка Приглашения`);
  }
  // В логах — метод, путь и статус; ни адресов и портов клиентов, ни тел, ни заголовков (T075, research R16).
  for (const line of [...net.logs, ...net.relays[0]!.logs, ...c1.logs, ...s1.logs]) {
    assert.doesNotMatch(line, /remoteAddress|remotePort|"headers"|"body"|authorization|cookie/i, line);
  }
  // В журнале и station_session — ни одного адреса (STATION-34).
  const rows = JSON.stringify([...net.server.db.prepare("SELECT * FROM journal").all(), ...net.server.db.prepare("SELECT * FROM station_session").all()]);
  assert.doesNotMatch(rows, /127\.0\.0\.1|::1|localhost/);
});

// Фича 005, T076: подпись версии Словаря файлом Ключа Координатора — пароль и файл ключа не попадают
// ни в журнал, ни в ответы API, ни в БД, ни в логи службы (принцип VII; NET-14, NET-54).
test("подпись версии Словаря: пароль и файл ключа нигде не остаются", async (t) => {
  const { buildVersion, readDictionarySource } = await import("@aristotel/core");
  const { serializeSignedDocument } = await import("@aristotel/protocol");
  const log: string[] = [];
  const svc = await startTestService(t, { logStream: { write: (line) => void log.push(line) } });
  const usb = emptyDataDir(t);
  const keyPath = join(usb, "c1.key");
  const publicKey = await writeCoordinatorKeyFile(keyPath, svc.dir);
  const pw = writePasswordFile(join(usb, "pw.txt"));
  const { insertCoordinatorKey, insertRegistryVersion, registryDocument, signDocument, testCoordinatorKey } = await import("../../support/harness.ts");
  insertCoordinatorKey(svc.db, svc.seniorId, publicKey);
  const regKey = testCoordinatorKey(0x11);
  insertRegistryVersion(svc.db, signDocument(registryDocument(svc.db, { coordinatorKeys: [publicKey, regKey.publicKey] }), regKey), svc.seniorId);
  const draft = join(usb, "v1.json");
  writeFileSync(draft, serializeSignedDocument(buildVersion({ source: readDictionarySource(join(import.meta.dirname, "..", "..", "..", "dictionary", "source")) }).doc));
  const signed = join(usb, "v1.signed.json");
  assert.equal((await runCli(["dictionary", "sign", draft, "--key", keyPath, "--password-file", pw, "--out", signed, "--yes", "--data-dir", usb])).code, 0);
  const res = await svc.maintenance.inject({ method: "POST", url: "/api/dictionary/versions", headers: { ...svc.maintenanceHeaders(), "content-type": "application/json" }, payload: readFileSync(signed, "utf8") });
  assert.equal(res.statusCode, 201, res.body);
  const keyText = readFileSync(keyPath, "utf8");
  const secrets = [TEST_KEY_PASSWORD, keyText.slice(0, 120), keyPath];
  const journal = JSON.stringify(svc.db.prepare("SELECT * FROM journal").all());
  const bank = readFileSync(join(svc.dir, "bank.sqlite")).toString("latin1");
  for (const s of secrets) {
    assert.ok(!journal.includes(s), "журнал");
    assert.ok(!res.body.includes(s), "ответ API");
    assert.ok(!bank.includes(s), "файл БД");
    assert.ok(!log.join("\n").includes(s), "лог службы");
  }
});
