// SC-002 (research R18 фичи 005; Clarifications фичи 005): применение версии 1 Словаря Сети со Стоп-листом
// в 38 291 строку — не дольше 60 с; версия, где изменился только Стоп-лист, при 100 000 значений в
// Банке — не дольше 30 с. Исходник — dictionary/source; списки §8.2, §8.6, §8.7 — синтетические, того
// же объёма, значения — детерминированный ГПСЧ с семенем; Индикаторы — условные значения. Цели
// проверяются на машине разработчика (plan.md, Performance Goals); тест прогоняет уменьшенный вариант.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "node:crypto";
import { parseSlovarBody, serializeSignedDocument, type StopListFile } from "@aristotel/protocol";
import {
  applyDictionaryVersion,
  buildVersion,
  closeDatabase,
  currentDictionary,
  ensureGroupKey,
  inTransaction,
  openBank,
  readDictionarySource,
  recomputeAll,
  registerModelTypes,
  writeInstall,
} from "@aristotel/core";
import { insertCoordinatorKey, insertRegistryVersion, registryDocument, signDocument, testCoordinatorKey } from "../tests/support/harness.ts";

const SOURCE = join(import.meta.dirname, "..", "dictionary", "source");

/** xorshift32 — детерминированный ГПСЧ: одинаковые синтетические значения на каждом прогоне. */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

function hex(next: () => number, length: number): string {
  let s = "";
  while (s.length < length) s += next().toString(16).padStart(8, "0");
  return s.slice(0, length);
}

function syntheticList(code: string, label: string, type: string, length: number, rows: number, next: () => number): StopListFile {
  return {
    format: "aristotel/stop-list/v1",
    code,
    label,
    source: "синтетический список замера SC-002",
    builtAt: "2026-10-19",
    rows: Array.from({ length: rows }, (_, i) => ({ type, kind: "value" as const, value: hex(next, length), note: `x ${i}` })),
  };
}

export interface BenchOptions {
  /** Строк в синтетических списках §8.2, §8.6, §8.7. */
  listRows: [number, number, number];
  values: number;
}

export interface BenchResult {
  stopListRows: number;
  values: number;
  applyV1Ms: number;
  applyStopOnlyMs: number;
}

export async function runBench(options: BenchOptions): Promise<BenchResult> {
  registerModelTypes();
  const dir = mkdtempSync(join(tmpdir(), "aristotel-bench-dictionary-"));
  try {
    const install = writeInstall(dir, { role: "base-station" });
    const db = openBank(dir, install);
    await ensureGroupKey(dir, db);
    const senior = randomUUIDv7();
    db.prepare("INSERT INTO member (id, label, role, state, createdAt) VALUES (?, 'С1', 'senior', 'active', ?)").run(senior, new Date().toISOString());
    const key = testCoordinatorKey(0x11);
    insertCoordinatorKey(db, senior, key.publicKey);
    insertRegistryVersion(db, signDocument(registryDocument(db, { coordinatorKeys: [key.publicKey] }), key), senior);

    const next = prng(0x5eed);
    const files = [
      syntheticList("pi_gen_commits", "Коммиты pi-gen официальных образов", "image_build", 40, options.listRows[0], next),
      syntheticList("px4_firmware", "Прошивки PX4", "file_sha256", 64, options.listRows[1], next),
      syntheticList("ardupilot_firmware", "Прошивки ArduPilot", "file_sha256", 64, options.listRows[2], next),
    ];
    const source = readDictionarySource(SOURCE);
    const v1 = signDocument(buildVersion({ source, stopListFiles: files }).doc, key);
    const body1 = parseSlovarBody(v1.body);
    const stopListRows = body1.stopLists.reduce((n, l) => n + l.rows.length, 0);
    let t0 = performance.now();
    applyDictionaryVersion(db, { bySignature: true }, serializeSignedDocument(v1));
    const applyV1Ms = performance.now() - t0;

    // 100 000 условных значений сопоставляемых типов — пакетной вставкой; их производное считается заранее.
    const types = body1.elements.filter((e) => e.kind === "indicator_type" && e.props["normClass"] === "hex");
    const at = new Date().toISOString();
    inTransaction(db, () => {
      const caseId = randomUUIDv7();
      const insert = db.prepare("INSERT INTO record (id, type, version, fields, createdAt, updatedAt, createdBy, updatedBy, secret) VALUES (?, 'indicator', 1, ?, ?, ?, ?, ?, 0)");
      for (let i = 0; i < options.values; i++) {
        const type = types[i % types.length]!;
        insert.run(randomUUIDv7(), JSON.stringify({ object: caseId, type: type.id, value: hex(next, 64), source: { kind: "manual" }, verified: true, case: caseId }), at, at, senior, senior);
      }
      recomputeAll(db, currentDictionary(db)!);
    });

    const v2 = signDocument(
      buildVersion({ source, previous: serializeSignedDocument(v1), stopListFiles: files.map((f, i) => (i === 2 ? { ...f, rows: [...f.rows, { type: "file_sha256", kind: "value", value: hex(next, 64), note: "x new" }] } : f)) }).doc,
      key,
    );
    t0 = performance.now();
    applyDictionaryVersion(db, { bySignature: true }, serializeSignedDocument(v2));
    const applyStopOnlyMs = performance.now() - t0;
    closeDatabase(db);
    return { stopListRows, values: options.values, applyV1Ms, applyStopOnlyMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runBench({ listRows: [113, 4774, 33_233], values: 100_000 });
  const ok = result.stopListRows === 38_291 && result.applyV1Ms <= 60_000 && result.applyStopOnlyMs <= 30_000;
  process.stdout.write(
    `Стоп-лист: ${result.stopListRows} строк; значений в Банке: ${result.values}\n` +
      `применение версии 1: ${(result.applyV1Ms / 1000).toFixed(1)} с (цель ≤ 60 с)\n` +
      `версия только со Стоп-листом: ${(result.applyStopOnlyMs / 1000).toFixed(1)} с (цель ≤ 30 с)\n` +
      `${ok ? "SC-002 выполнен" : "SC-002 НЕ выполнен"}\n`,
  );
  process.exitCode = ok ? 0 : 1;
}
