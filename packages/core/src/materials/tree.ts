// Дерево Материалов Опорной станции (BANK-10, BANK-11, BANK-14, STATION-30; research R4, R7 фичи 006;
// data-model.md «Файлы»): materials/cases/<Кейс>/<путь>, рядом — файлы всех Заверений
// <путь>.zaverenie-<n>.json; недоставленные части — materials/.incoming/<Идентификатор>. Файлы — только
// на чтение (0440), каталоги — 0750, .incoming — 0700. В дерево файл попадает целиком одним
// переименованием или не попадает вовсе (FR-011). Файловое дерево трогает только этот модуль.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { attestationFileName } from "@aristotel/protocol";

export const MATERIALS_DIR = "materials";
const INCOMING = ".incoming";

export interface MaterialOwnerRef {
  type: "case" | "document";
  id: string;
}

export function materialsRoot(dataDir: string): string {
  return join(dataDir, MATERIALS_DIR);
}

function ownerDir(dataDir: string, owner: MaterialOwnerRef): string {
  return join(materialsRoot(dataDir), owner.type === "case" ? "cases" : "documents", owner.id);
}

/** Путь файла Материала в дереве; path уже проверен checkMaterialPath (без «..», абсолютных и «\»). */
export function materialFilePath(dataDir: string, owner: MaterialOwnerRef, path: string): string {
  return join(ownerDir(dataDir, owner), ...path.split("/"));
}

export function attestationFilePath(dataDir: string, owner: MaterialOwnerRef, path: string, n: number): string {
  return materialFilePath(dataDir, owner, attestationFileName(path, n));
}

export function incomingPath(dataDir: string, id: string): string {
  const dir = join(materialsRoot(dataDir), INCOMING);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, id);
}

function fsyncDir(path: string): void {
  // На Windows каталог не открыть для fsync — переименование там и так сквозное.
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // нечего делать
  }
}

/** Создать каталоги до файла с правами 0750 — каждый уровень, а не только последний. */
function makeParents(file: string, root: string): void {
  const chain: string[] = [];
  for (let dir = dirname(file); dir.length > root.length && !existsSync(dir); dir = dirname(dir)) chain.unshift(dir);
  for (const dir of chain) {
    mkdirSync(dir, { mode: 0o750 });
    chmodSync(dir, 0o750);
  }
}

/**
 * Положить собранный файл в дерево: права только на чтение, переименование из .incoming, рядом — файлы
 * Заверений по порядку (research R7). Повторный вызов после сбоя дописывает недостающее.
 */
export function placeDelivered(dataDir: string, id: string, owner: MaterialOwnerRef, path: string, attestations: string[]): void {
  const root = materialsRoot(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o750 });
  const target = materialFilePath(dataDir, owner, path);
  makeParents(target, root);
  const source = incomingPath(dataDir, id);
  if (existsSync(source)) {
    chmodSync(source, 0o440);
    renameSync(source, target);
  }
  attestations.forEach((text, i) => {
    const file = attestationFilePath(dataDir, owner, path, i + 1);
    if (existsSync(file)) return;
    writeFileSync(file, text, { mode: 0o440 });
    chmodSync(file, 0o440);
  });
  fsyncDir(dirname(target));
}

function removeReadOnly(file: string): void {
  if (!existsSync(file)) return;
  chmodSync(file, 0o600); // на Windows атрибут «только чтение» мешает удалению
  rmSync(file, { force: true });
}

/** Убрать файл Материала, все его Заверения и недоставленную часть — удаление Старшим (research R10). */
export function removeFromTree(dataDir: string, id: string, owner: MaterialOwnerRef, path: string, attestationCount: number): void {
  removeReadOnly(materialFilePath(dataDir, owner, path));
  for (let n = 1; n <= attestationCount; n++) removeReadOnly(attestationFilePath(dataDir, owner, path, n));
  rmSync(join(materialsRoot(dataDir), INCOMING, id), { force: true });
}
