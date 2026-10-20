// Хранилище Материалов Станции (data-model.md «Файлы», Станция; research R1 фичи 006): копия файла под
// управлением программы — materials/<Идентификатор>, только на чтение; Заверение этой Станции рядом —
// materials/<Идентификатор>.zaverenie.json. Хэш и размер считаются тем же проходом, что и копирование:
// в Заверение идёт то, что записано у Станции, а не то, что лежало по исходному пути.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { attestationFileText, type Attestation } from "@aristotel/protocol";

export const MATERIALS_DIR = "materials";

export function materialsDir(dataDir: string): string {
  return join(dataDir, MATERIALS_DIR);
}

export function materialCopyPath(dataDir: string, id: string): string {
  return join(materialsDir(dataDir), id);
}

export function materialAttestationPath(dataDir: string, id: string): string {
  return join(materialsDir(dataDir), `${id}.zaverenie.json`);
}

export class MaterialFileError extends Error {
  readonly code: "material_file_unreadable" | "material_file_not_regular";
  constructor(code: "material_file_unreadable" | "material_file_not_regular") {
    super(code);
    this.code = code;
  }
}

/** Исходный файл — обычный и читаемый (внешний инструмент его уже снял, APP-10). */
export function checkSourceFile(file: string): number {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new MaterialFileError("material_file_unreadable");
  }
  if (!stat.isFile()) throw new MaterialFileError("material_file_not_regular");
  return stat.size;
}

/**
 * Скопировать source в хранилище Станции под Идентификатором id одним потоком с SHA-256 и счётчиком
 * байт во временный файл; verify решает до замены, годится ли копия (T093): нет — временный файл
 * удаляется, а прежняя копия этого Материала на Станции не трогается. Годится — fsync, замена
 * прежней копии (с неё снимается «только чтение», иначе Windows не даст заменить), права только на
 * чтение. Исходный файл только читается.
 */
export async function copyWithHash(
  dataDir: string,
  source: string,
  id: string,
  verify?: (sha256: string, size: number) => boolean,
  name: string = id,
): Promise<{ sha256: string; size: number; placed: boolean }> {
  mkdirSync(materialsDir(dataDir), { recursive: true, mode: 0o700 });
  const target = materialCopyPath(dataDir, name);
  const part = `${target}.${randomBytes(6).toString("hex")}.part`;
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(source, { flags: "r" }), tap, createWriteStream(part, { mode: 0o600, flush: true }));
  } catch (error) {
    rmSync(part, { force: true });
    if ((error as { code?: string }).code === "EISDIR") throw new MaterialFileError("material_file_not_regular");
    if (typeof (error as { code?: string }).code === "string") throw new MaterialFileError("material_file_unreadable");
    throw error;
  }
  const sha256 = hash.digest("hex");
  if (verify !== undefined && !verify(sha256, size)) {
    rmSync(part, { force: true });
    return { sha256, size, placed: false };
  }
  if (existsSync(target)) {
    chmodSync(target, 0o600);
    rmSync(target, { force: true });
  }
  renameSync(part, target);
  chmodSync(target, 0o444);
  return { sha256, size, placed: true };
}

export function writeAttestationFile(dataDir: string, attestation: Attestation, name: string = attestation.material): void {
  const path = materialAttestationPath(dataDir, name);
  writeFileSync(path, attestationFileText(attestation), { mode: 0o600 });
}

/**
 * Перенести копию и Заверение из временного имени на место Материала id, заменив прежние (T096): только
 * после ответа 201 Опорной станции.
 */
export function promoteMaterialCopy(dataDir: string, staging: string, id: string): void {
  const target = materialCopyPath(dataDir, id);
  if (existsSync(target)) {
    chmodSync(target, 0o600);
    rmSync(target, { force: true });
  }
  renameSync(materialCopyPath(dataDir, staging), target);
  renameSync(materialAttestationPath(dataDir, staging), materialAttestationPath(dataDir, id));
}

/** Убрать копию и Заверение — Опорная станция отказала в Записи (contracts/lokalnaya-chast.md). */
export function removeMaterialCopy(dataDir: string, id: string): void {
  const copy = materialCopyPath(dataDir, id);
  if (existsSync(copy)) chmodSync(copy, 0o600);
  rmSync(copy, { force: true });
  rmSync(materialAttestationPath(dataDir, id), { force: true });
}
