// T060 фичи 004 — подпись черновика версии Реестра в интерфейсе (NET-14): файл Ключа Координатора и
// его пароль — в локальной части, затем применение с подтверждением присутствия (STATION-12); файл и
// пароль нигде не сохраняются (research R10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEST_STATION_PASSWORD, startNetwork, startStation, tempDir, uiLogin, waitFor } from "../../support/network.ts";
import { writeCoordinatorKeyFile } from "../../support/harness.ts";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));
}

test("NET-14: черновик → подпись файлом ключа (два пароля) → применение; неверный пароль ключа — отказ", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const ui = await uiLogin(station);
  // Новый Ключ Координатора С1 — файл на носителе; регистрация прежнего ключа снимается.
  const keyPath = join(tempDir(t), "coordinator.key");
  const publicKey = await writeCoordinatorKeyFile(keyPath, station.dir, "key-password-x");
  const keyFile = readFileSync(keyPath, "utf8");
  assert.equal((await ui.call("POST", "/api/coordinator-keys/withdraw", {})).status, 200);
  const { coordinatorKeyProofMessage } = await import("@aristotel/protocol");
  const { openKeyText } = await import("@aristotel/core");
  const opened = await openKeyText(keyFile, "key-password-x");
  const regBody = { publicKey, proof: Buffer.from(opened.sign(coordinatorKeyProofMessage(net.server.install.installId, net.seniorId))).toString("base64").replace(/=+$/, "") };
  const regPresence = String((await ui.call("POST", "/local/presence", { password: TEST_STATION_PASSWORD, method: "POST", path: "/api/coordinator-keys", body: regBody })).body["presence"]);
  assert.equal((await ui.call("POST", "/api/coordinator-keys", regBody, { "aristotel-presence": regPresence })).status, 201);
  // Черновик собирает Опорная станция; подпись — в локальной части.
  const draft = await ui.call("POST", "/api/registry/draft", {});
  assert.equal(draft.status, 200, draft.text);
  // Без любого из двух паролей подписи нет (US4.9): пароль Станции и пароль файла ключа.
  const sign = (body: Record<string, unknown>) => ui.call("POST", "/local/coordinator-sign", body);
  const wrongKey = await sign({ password: TEST_STATION_PASSWORD, keyFile, keyPassword: "wrong-password-x", draft: draft.body });
  assert.equal(wrongKey.status, 403);
  assert.equal(wrongKey.body["document"], undefined);
  const wrongStation = await sign({ password: "wrong-password-x", keyFile, keyPassword: "key-password-x", draft: draft.body });
  assert.deepEqual([wrongStation.status, wrongStation.body["error"]], [403, "password_wrong"]);
  assert.equal((await sign({ keyFile, keyPassword: "key-password-x", draft: draft.body })).status, 400, "без пароля Станции");
  // Версию 2 подписывает ключ из версии 1 (NET-09): сперва — прежним ключом стенда, его файл — тестовый.
  const { signDocument } = await import("../../support/harness.ts");
  const signedByOld = signDocument(draft.body as never, net.coordinatorKey);
  const withNew = await sign({ password: TEST_STATION_PASSWORD, keyFile, keyPassword: "key-password-x", draft: signedByOld });
  assert.equal(withNew.status, 200, withNew.text);
  const document = withNew.body["document"] as { signatures: { key: string }[] };
  assert.deepEqual(document.signatures.map((s) => s.key), [net.coordinatorKey.publicKey, publicKey]);
  assert.equal((await ui.call("POST", "/api/registry/versions", document)).body["error"], "presence_required");
  // Подтверждение присутствия для применения выдано вместе с подписью — третьего пароля нет.
  const applied = await ui.call("POST", "/api/registry/versions", document, { "aristotel-presence": String(withNew.body["presence"]) });
  assert.equal(applied.status, 201, applied.text);
  assert.equal(net.registryNumber(), 2);
  // Файла ключа и его пароля нет ни в каталоге данных Станции, ни в логах.
  for (const file of filesUnder(station.dir)) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(keyFile.slice(40, 120)), file);
    assert.ok(!text.includes("key-password-x"), file);
  }
});

test("подпись на запертой Станции — 423 station_locked, подписи нет", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net, net.seniorId, { unlock: false });
  const ui = await uiLogin(station);
  const keyPath = join(tempDir(t), "coordinator.key");
  await writeCoordinatorKeyFile(keyPath, station.dir, "key-password-x");
  const res = await ui.call("POST", "/local/coordinator-sign", { password: TEST_STATION_PASSWORD, keyFile: readFileSync(keyPath, "utf8"), keyPassword: "key-password-x", draft: { format: "x", body: "{}", signatures: [] } });
  assert.deepEqual([res.status, res.body["error"], res.body["document"]], [423, "station_locked", undefined]);
});
