// T029 — подпись версии Словаря Сети в интерфейсе Станции (Clarifications фичи 005; research R15;
// DICT-16, STATION-12, NET-14): файл Ключа Координатора и два пароля — в локальной части, подача с
// подтверждением присутствия; версия около 20 МиБ проходит локальную часть и Проход.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_STATION_PASSWORD, startNetwork, startStation, tempDir, uiLogin, waitFor } from "../../support/network.ts";
import { signDocument, writeCoordinatorKeyFile } from "../../support/harness.ts";
import { T, testDictionaryDocument } from "../../support/dictionary.ts";

test("подпись версии Словаря в интерфейсе: два пароля, подача с присутствием; 20 МиБ через Проход", async (t) => {
  const net = await startNetwork(t, { relays: 1 });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  const station = await startStation(t, net);
  const ui = await uiLogin(station);
  const keyPath = join(tempDir(t), "coordinator.key");
  const publicKey = await writeCoordinatorKeyFile(keyPath, station.dir, "key-password-x");
  const keyFile = readFileSync(keyPath, "utf8");
  // Около 20 МиБ: список Стоп-листа из 180 000 условных строк SHA-256.
  const unsigned = testDictionaryDocument({
    change: (b) => {
      const rows: [string, "value", string, string][] = [];
      for (let i = 0; i < 180_000; i++) rows.push([T.indicator("file_sha256"), "value", i.toString(16).padStart(64, "0"), `x ${i}`]);
      b.stopLists.push({ id: "0190a000-0000-7000-8000-0000000fffff", code: "x_big", label: "x", source: "x", builtAt: "2026-10-19", rows });
    },
  });
  assert.ok(unsigned.body.length > 15 * 1024 * 1024);
  // Подпись ключом из Реестра стенда — заранее; второй подписью — файл ключа в локальной части.
  const draft = signDocument(unsigned, net.coordinatorKey);
  const sign = (body: Record<string, unknown>) => ui.call("POST", "/local/coordinator-sign", { format: "aristotel/slovar/v1", ...body });
  const wrong = await sign({ password: "wrong-password-x", keyFile, keyPassword: "key-password-x", draft });
  assert.deepEqual([wrong.status, wrong.body["error"]], [403, "password_wrong"]);
  const signed = await sign({ password: TEST_STATION_PASSWORD, keyFile, keyPassword: "key-password-x", draft });
  assert.equal(signed.status, 200, signed.text);
  const document = signed.body["document"] as { signatures: { key: string }[] };
  assert.deepEqual(document.signatures.map((s) => s.key), [net.coordinatorKey.publicKey, publicKey]);
  assert.equal((await ui.call("POST", "/api/dictionary/versions", document)).body["error"], "presence_required");
  const applied = await ui.call("POST", "/api/dictionary/versions", document, { "aristotel-presence": String(signed.body["presence"]) });
  assert.equal(applied.status, 201, applied.text);
  assert.equal(applied.body["number"], 1);
  assert.equal((await ui.call("GET", "/api/dictionary")).body["current"] !== null, true);
});
