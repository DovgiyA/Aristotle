// T028 — aristotel dictionary по contracts/cli.md фичи 005: build и sign без службы; apply, show,
// export, elements, stop-lists через API сопровождения Опорной станции (APP-34, NET-54); --json;
// --out не перезаписывается; отказ применения — причина по-русски, код 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SLOVAR_FORMAT, SLOVAR_MAX_BODY_BYTES, keyFingerprint, parseSignedDocument, parseSlovarBody, verifySignature } from "@aristotel/protocol";
import { RELAY_X, emptyDataDir, freePort, runCli, spawnService, writeCoordinatorKeyFile, writePasswordFile } from "../../../tests/support/harness.ts";

const SOURCE = join(import.meta.dirname, "..", "..", "..", "dictionary", "source");

test("build и sign — без установки и без службы; отчёт называет списки без значений; --out не перезаписывается", async (t) => {
  const nowhere = emptyDataDir(t);
  const usb = emptyDataDir(t);
  const out = join(usb, "slovar-1.json");
  const built = await runCli(["dictionary", "build", "--source", SOURCE, "--out", out, "--json", "--data-dir", nowhere]);
  assert.equal(built.code, 0, built.stderr);
  const report = JSON.parse(built.stdout) as { number: number; missingStopLists: string[] };
  assert.equal(report.number, 1);
  assert.deepEqual(report.missingStopLists.sort(), ["ardupilot_firmware", "pi_gen_commits", "px4_firmware"]);
  assert.equal((await runCli(["dictionary", "build", "--source", SOURCE, "--out", out, "--data-dir", nowhere])).code, 1, "--out не перезаписывается");

  const key = join(usb, "c1.key");
  const publicKey = await writeCoordinatorKeyFile(key, nowhere);
  const pw = writePasswordFile(join(usb, "pw.txt"));
  const unconfirmed = await runCli(["dictionary", "sign", out, "--key", key, "--password-file", pw, "--out", join(usb, "x.json"), "--data-dir", nowhere]);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.stdout, /Версия Словаря Сети\s+1/);
  assert.equal(existsSync(join(usb, "x.json")), false);
  const signedPath = join(usb, "slovar-1.signed.json");
  const signed = await runCli(["dictionary", "sign", out, "--key", key, "--password-file", pw, "--out", signedPath, "--yes", "--json", "--data-dir", nowhere]);
  assert.equal(signed.code, 0, signed.stderr);
  assert.equal(JSON.parse(signed.stdout).keyFingerprint, keyFingerprint(publicKey));
  const doc = parseSignedDocument(readFileSync(signedPath, "utf8"), SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES });
  assert.ok(verifySignature(doc, publicKey));
  assert.equal(existsSync(join(nowhere, "install.json")), false);
});

test("apply, show, export, elements, stop-lists через CLI на Опорной станции; повтор — та же версия; отказ — по-русски", async (t) => {
  const dir = emptyDataDir(t);
  const port = await freePort();
  assert.equal((await runCli(["init", "--role", "base-station", "--senior-label", "С1", "--port", String(port), "--data-dir", dir])).code, 0);
  const service = await spawnService(t, dir);
  const cli = (...args: string[]) => runCli([...args, "--data-dir", dir]);
  const usb = emptyDataDir(t);
  const key = join(usb, "c1.key");
  await writeCoordinatorKeyFile(key, dir);
  const pw = writePasswordFile(join(usb, "pw.txt"));
  assert.equal((await cli("coordinator-key", "register", key, "--password-file", pw)).code, 0);
  const draft = join(usb, "r1.draft.json");
  assert.equal((await cli("registry", "draft", "--code", "A", "--add-relay", `${RELAY_X.url}=${RELAY_X.tlsSpki}`, "--out", draft)).code, 0);
  const r1 = join(usb, "r1.json");
  assert.equal((await runCli(["registry", "sign", draft, "--key", key, "--password-file", pw, "--out", r1, "--yes"])).code, 0);
  assert.equal((await cli("registry", "apply", r1)).code, 0);

  assert.match((await cli("dictionary", "show")).stdout, /не применён/);
  const v1 = join(usb, "slovar-1.json");
  const v1s = join(usb, "slovar-1.signed.json");
  const builtV1 = await runCli(["dictionary", "build", "--source", SOURCE, "--out", v1]);
  assert.equal(builtV1.code, 0);
  // T157: виды элементов — по-русски, не ключами.
  assert.match(builtV1.stdout, /типов Индикаторов \d+/);
  assert.doesNotMatch(builtV1.stdout, /indicator_type/);
  assert.equal((await runCli(["dictionary", "sign", v1, "--key", key, "--password-file", pw, "--out", v1s, "--yes"])).code, 0);
  const applied = await cli("dictionary", "apply", v1s, "--json");
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).number, 1);
  assert.equal((await cli("dictionary", "apply", v1s)).code, 0, "та же версия — без изменений");
  const show = JSON.parse((await cli("dictionary", "show", "--json")).stdout) as { current: { number: number } };
  assert.equal(show.current.number, 1);

  const exported = join(usb, "slovar-1.applied.json");
  assert.equal((await cli("dictionary", "export", "--out", exported)).code, 0);
  assert.equal(parseSlovarBody(parseSignedDocument(readFileSync(exported, "utf8"), SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES }).body).number, 1);

  // elements и stop-lists — маршруты для Станций: CLI на Опорной станции их не отдаёт (APP-34).
  const elements = await cli("dictionary", "elements", "--kind", "enum");
  assert.equal(elements.code, 1);
  assert.match(elements.stderr, /Станции/);

  // Версия 3 при применённой 1 — отказ gap, причина по-русски.
  const v2 = join(usb, "slovar-2.json");
  assert.equal((await runCli(["dictionary", "build", "--source", SOURCE, "--previous", exported, "--out", v2])).code, 0);
  const v2s = join(usb, "slovar-2.signed.json");
  assert.equal((await runCli(["dictionary", "sign", v2, "--key", key, "--password-file", pw, "--out", v2s, "--yes"])).code, 0);
  const v2e = join(usb, "slovar-2.applied.json");
  const v3 = join(usb, "slovar-3.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(v2e, readFileSync(v2s, "utf8"));
  assert.equal((await runCli(["dictionary", "build", "--source", SOURCE, "--previous", v2e, "--out", v3])).code, 0);
  const v3s = join(usb, "slovar-3.signed.json");
  assert.equal((await runCli(["dictionary", "sign", v3, "--key", key, "--password-file", pw, "--out", v3s, "--yes"])).code, 0);
  const gap = await cli("dictionary", "apply", v3s);
  assert.equal(gap.code, 1);
  assert.match(gap.stderr, /ожидается версия 2/);
  // T114, contracts/cli.md: apply печатает номер и счётчики применения; --json — поле applied.
  assert.equal(typeof JSON.parse(applied.stdout).applied.stopListRows, "number");
  const second = await cli("dictionary", "apply", v2s);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Версия Словаря Сети\s+2/);
  assert.match(second.stdout, /Счётчики применения\s+.*строк Стоп-листа \d+/);
  assert.doesNotMatch(second.stdout, /stopListRows/, "T140: подписи по-русски");
  await service.stop();
});

test("T200: build с испорченным --previous или файлом списка — причина по-русски и код 1, а не «непредвиденная ошибка»", async (t) => {
  const { cpSync, writeFileSync } = await import("node:fs");
  const usb = emptyDataDir(t);
  const build = (...args: string[]) => runCli(["dictionary", "build", ...args, "--data-dir", usb]);
  const bad = join(usb, "bad.json");
  writeFileSync(bad, "{не json");
  const prev = await build("--source", SOURCE, "--previous", bad, "--out", join(usb, "a.json"));
  assert.equal(prev.code, 1, prev.stderr);
  assert.match(prev.stderr, /bad\.json — не документ версии Словаря Сети/);
  const list = join(usb, "list.json");
  writeFileSync(list, JSON.stringify({ format: "aristotel/stop-list/v1", code: "px4_firmware" }));
  const flag = await build("--source", SOURCE, "--stop-list", list, "--out", join(usb, "b.json"));
  assert.equal(flag.code, 1, flag.stderr);
  assert.match(flag.stderr, /list\.json: Файл списка Стоп-листа не по формату/);
  const source = join(usb, "source");
  cpSync(SOURCE, source, { recursive: true });
  writeFileSync(join(source, "stop-lists", "broken.json"), "{не json");
  const inSource = await build("--source", source, "--out", join(usb, "c.json"));
  assert.equal(inSource.code, 1, inSource.stderr);
  assert.match(inSource.stderr, /broken\.json: Документ не JSON/);
  for (const r of [prev, flag, inSource]) assert.doesNotMatch(r.stderr, /непредвиденная ошибка/);
});

test("T214: build с испорченным исходником или без файла --stop-list — причина с именем файла и код 1", async (t) => {
  const { cpSync, readFileSync: read, writeFileSync } = await import("node:fs");
  const usb = emptyDataDir(t);
  const build = (...args: string[]) => runCli(["dictionary", "build", ...args, "--data-dir", usb]);
  let n = 0;
  const broken = (change: (dir: string) => void) => {
    const dir = join(usb, `src${++n}`);
    cpSync(SOURCE, dir, { recursive: true });
    change(dir);
    return dir;
  };
  const merges = broken((dir) => {
    const m = JSON.parse(read(join(dir, "merges.json"), "utf8")) as Record<string, unknown>;
    delete m["localTypes"];
    writeFileSync(join(dir, "merges.json"), JSON.stringify(m));
  });
  const enums = broken((dir) => writeFileSync(join(dir, "enums.json"), "{"));
  const cases: [string[], RegExp][] = [
    [["--source", merges], /merges\.json/],
    [["--source", enums], /enums\.json: Документ не JSON/],
    [["--source", join(usb, "nowhere")], /nowhere/],
    [["--source", SOURCE, "--stop-list", join(usb, "missing.json")], /missing\.json/],
  ];
  for (const [args, reason] of cases) {
    const res = await build(...args, "--out", join(usb, `out${++n}.json`));
    assert.equal(res.code, 1, res.stderr);
    assert.match(res.stderr, reason);
    assert.doesNotMatch(res.stderr, /непредвиденная ошибка/);
  }
});

test("T220: sign показывает отпечаток ключа до подтверждения", async (t) => {
  const nowhere = emptyDataDir(t);
  const usb = emptyDataDir(t);
  const out = join(usb, "slovar-1.json");
  assert.equal((await runCli(["dictionary", "build", "--source", SOURCE, "--out", out, "--data-dir", nowhere])).code, 0);
  const key = join(usb, "c1.key");
  const publicKey = await writeCoordinatorKeyFile(key, nowhere);
  const pw = writePasswordFile(join(usb, "pw.txt"));
  const unconfirmed = await runCli(["dictionary", "sign", out, "--key", key, "--password-file", pw, "--out", join(usb, "x.json"), "--data-dir", nowhere]);
  assert.equal(unconfirmed.code, 1);
  assert.ok(unconfirmed.stdout.includes(keyFingerprint(publicKey)), unconfirmed.stdout);
});

test("T240: dictionary export --number не номер — причина и код 1, а не «не применён»", async (t) => {
  const dir = emptyDataDir(t);
  for (const n of ["abc", "0", "1.5"]) {
    const res = await runCli(["dictionary", "export", "--out", join(dir, "x.json"), "--number", n, "--data-dir", dir]);
    assert.equal(res.code, 1, res.stderr);
    assert.match(res.stderr, new RegExp(`неверный номер версии: ${n.replace(".", "\\.")}`));
    assert.doesNotMatch(res.stderr, /не применён/);
  }
});
