// Стенд фичи 006 (research R13): синтетические файлы из ГПСЧ с семенем (принцип VII) и Заверения
// тестовых Станций. Значения условные; содержимое файлов — шум AES-CTR, ни одного значения из дел.
import { createCipheriv, createHash, randomUUIDv7 } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { ed25519Sign, serializeSignedDocument, signAttestation, type Attestation } from "@aristotel/protocol";
import { readAccessToken } from "@aristotel/core";
import { addMember, signDocument, type TestSession } from "./harness.ts";
import { EV, testDictionaryDocument } from "./dictionary.ts";
import { startNetwork, startStation, tempDir, waitFor, type TestNetwork, type TestStation } from "./network.ts";

export const MiB = 1024 * 1024;

/** Детерминированные байты: AES-128-CTR с ключом из семени над нулями. */
export function syntheticBytes(size: number, seed: string): Buffer {
  const key = createHash("sha256").update(`material:${seed}`).digest().subarray(0, 16);
  const cipher = createCipheriv("aes-128-ctr", key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(Buffer.alloc(size)), cipher.final()]);
}

/** Синтетический файл размера size в каталоге dir; путь — результат. */
export function syntheticFile(dir: string, name: string, size: number, seed = name): string {
  const path = join(dir, name);
  writeFileSync(path, syntheticBytes(size, seed));
  return path;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface MaterialFacts {
  id?: string;
  caseId: string;
  sha256: string;
  size: number | string;
  at?: string;
}

/** Заверение тестовой Станции сеанса: подпись её Ключом станции (STATION-29). */
export function attestAs(session: Pick<TestSession, "stationId" | "key" | "publicKey">, facts: MaterialFacts & { id: string }): Attestation {
  return signAttestation((m) => ed25519Sign(session.key, m), {
    material: facts.id,
    owner: { case: facts.caseId },
    sha256: facts.sha256,
    size: String(facts.size),
    station: session.stationId,
    stationKey: session.publicKey,
    at: facts.at ?? new Date().toISOString(),
  });
}

/** Тело POST /api/materials с Заверением Станции сеанса. */
export function materialRequest(
  session: Pick<TestSession, "stationId" | "key" | "publicKey">,
  facts: MaterialFacts,
  extra: { path?: string; kind?: string | null; previousAttestations?: unknown[]; attestation?: unknown } = {},
): Record<string, unknown> {
  const id = facts.id ?? randomUUIDv7();
  const body: Record<string, unknown> = {
    id,
    owner: { case: facts.caseId },
    path: extra.path ?? `${id}.bin`,
    sha256: facts.sha256,
    size: String(facts.size),
    attestation: extra.attestation ?? attestAs(session, { ...facts, id }),
  };
  if (extra.kind !== undefined) body["kind"] = extra.kind;
  if (extra.previousAttestations !== undefined) body["previousAttestations"] = extra.previousAttestations;
  return body;
}

// --- Сеть стенда (фича 004) с применённым Словарём Сети и Кейсом У1 ---


/** Применить Словарь Сети стенда на Опорной станции сети: подпись Ключом Координатора сети. */
export async function applyDictionaryOnNetwork(net: TestNetwork): Promise<void> {
  const doc = signDocument(testDictionaryDocument(), net.coordinatorKey);
  const res = await net.server.app.inject({
    method: "POST",
    url: "/api/dictionary/versions",
    headers: { "aristotel-api-version": "1", authorization: `Bearer ${readAccessToken(net.dir)}`, "content-type": "application/json" },
    payload: serializeSignedDocument(doc),
  });
  if (res.statusCode !== 201 && res.statusCode !== 200) throw new Error(`Словарь сети стенда не применён: ${res.statusCode} ${res.body}`);
}

export interface MaterialNetwork {
  net: TestNetwork;
  u1: string;
  s1: TestStation;
  caseId: string;
  /** Каталог для синтетических «снятых» файлов (внешний инструмент, APP-10). */
  files: string;
}

/** Сеть, Словарь, Станция S1 Участника У1 и Кейс У1 в Черновике. */
export async function materialNetwork(t: TestContext, options: { extend?: Parameters<typeof startNetwork>[1] extends infer O ? O extends { extend?: infer E } ? E : never : never } = {}): Promise<MaterialNetwork> {
  const net = await startNetwork(t, options.extend === undefined ? { relays: 1 } : { relays: 1, extend: options.extend });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  await applyDictionaryOnNetwork(net);
  const u1 = addMember(net.server.db, "У1");
  const s1 = await startStation(t, net, u1);
  const kase = await s1.local("POST", "/api/records", { type: "case", fields: { shape: EV("case_shape", "single_item") } });
  if (kase.status !== 201) throw new Error(`Кейс не создан: ${kase.status} ${kase.text}`);
  return { net, u1, s1, caseId: String(kase.body["id"]), files: tempDir(t, "aristotel-files-") };
}
