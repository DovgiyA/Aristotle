// T024 — шаг 22.3 в границах фичи 005: С1 собирает версию n+1 — два типа Сети склеены синонимом, тип
// стал сопоставляемым, в Стоп-лист добавлено `v`, убрано `w` — и подписывает её Ключом Координатора
// (Ed25519) командой CLI без службы: файл ключа и пароль, без подтверждения присутствия (NET-54).
// Подпись в интерфейсе Станции с двумя паролями — tests/acceptance/common/dictionary-sign-ui.test.ts.
// DICT-12, DICT-16, DICT-22, DICT-54, NET-14, NET-40.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SLOVAR_FORMAT, SLOVAR_MAX_BODY_BYTES, bodySha256, parseSignedDocument, parseSlovarBody, verifySignature, type DictionarySource } from "@aristotel/protocol";
import { emptyDataDir, runCli, writeCoordinatorKeyFile, writePasswordFile } from "../../support/harness.ts";

const SOURCE = join(import.meta.dirname, "..", "..", "..", "dictionary", "source");

test("22.3: версия n+1 собрана и подписана CLI без службы; синоним, сопоставляемость, Стоп-лист — в теле", async (t) => {
  const usb = emptyDataDir(t);
  const nowhere = emptyDataDir(t);
  const key = join(usb, "c1.key");
  const publicKey = await writeCoordinatorKeyFile(key, nowhere);
  const pw = writePasswordFile(join(usb, "pw.txt"));
  const sign = async (input: string, out: string) => {
    const r = await runCli(["dictionary", "sign", input, "--key", key, "--password-file", pw, "--out", out, "--yes", "--data-dir", nowhere]);
    assert.equal(r.code, 0, r.stderr);
  };
  const v1 = join(usb, "v1.json");
  assert.equal((await runCli(["dictionary", "build", "--source", SOURCE, "--out", v1, "--data-dir", nowhere])).code, 0);
  await sign(v1, join(usb, "v1.signed.json"));

  // Копия исходника: в версии n+1 x509_cn — синоним x509_fingerprint (условная склейка теста),
  // os_version стал сопоставляемым, в «Общие умолчания» добавлено v, убрана строка w.
  const src = join(usb, "source");
  cpSync(SOURCE, src, { recursive: true });
  const types = JSON.parse(readFileSync(join(src, "types.json"), "utf8")) as DictionarySource["types"];
  types.indicatorTypes.find((x) => x.code === "os_version")!.comparable = true;
  writeFileSync(join(src, "types.json"), JSON.stringify(types));
  writeFileSync(join(src, "merges.json"), JSON.stringify({ synonyms: [{ absorbed: "indicator_type:x509_cn", canonical: "indicator_type:x509_fingerprint" }], localTypes: [], deprecated: [] }));
  const listPath = join(src, "stop-lists", "common_defaults.json");
  const list = JSON.parse(readFileSync(listPath, "utf8")) as { rows: { type: string; kind: string; value: string; note: string }[] };
  list.rows = list.rows.filter((r) => !(r.type === "ssid" && r.value === "default"));
  list.rows.push({ type: "username", kind: "value", value: "v", note: "учётка по умолчанию" });
  writeFileSync(listPath, JSON.stringify(list));

  const v2 = join(usb, "v2.json");
  const built = await runCli(["dictionary", "build", "--source", src, "--previous", join(usb, "v1.signed.json"), "--out", v2, "--data-dir", nowhere]);
  assert.equal(built.code, 0, built.stderr);
  const v2s = join(usb, "v2.signed.json");
  await sign(v2, v2s);
  const doc = parseSignedDocument(readFileSync(v2s, "utf8"), SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES });
  assert.ok(verifySignature(doc, publicKey), "подпись Ed25519 Ключом Координатора");
  const body = parseSlovarBody(doc.body);
  const prev = parseSlovarBody(parseSignedDocument(readFileSync(join(usb, "v1.signed.json"), "utf8"), SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES }).body);
  assert.equal(body.number, 2);
  assert.equal(body.previousSha256, bodySha256(JSON.stringify(prev)));
  const cn = body.elements.find((e) => e.code === "x509_cn")!;
  const fp = body.elements.find((e) => e.code === "x509_fingerprint")!;
  assert.deepEqual([cn.state, cn.canonical], ["absorbed", fp.id]);
  assert.deepEqual(body.merges, [{ absorbed: cn.id, canonical: fp.id }]);
  assert.equal(body.elements.find((e) => e.code === "os_version")!.props["comparable"], true);
  const rows = body.stopLists.find((l) => l.code === "common_defaults")!.rows;
  assert.ok(rows.some(([, , v]) => v === "v"));
  assert.ok(!rows.some(([, , v, n]) => v === "default" && n.includes("SSID")));
});
