// Реестр Сети на Ретрансляторе: подписанные версии как есть — файлами registry/<номер>.json; первая
// версия — при установке от Опорной станции своей Группы; следующие — по правилам станции (NET-09,
// NET-12) общей функцией checkSuccessor; развилка — registry/conflicts.json, остановку снимает
// следующая версия по RELAY-25 (RELAY-11, RELAY-19, RELAY-21, RELAY-25; research R3 фичи 004).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REGISTRY_FORMAT,
  bodySha256,
  checkSuccessor,
  parseRegistryBody,
  parseSignedDocument,
  serializeSignedDocument,
  signerAmong,
  type KnownVersion,
  type RegistryBody,
  type RegistryGroup,
  type SignedDocument,
} from "@aristotel/protocol";

interface Stored extends KnownVersion {
  text: string;
  doc: SignedDocument;
}

export interface RelayConflict {
  number: number;
  bodySha256: string[];
  receivedAt: string;
  resolvedBy: number | null;
}

export type ApplyResult =
  | { kind: "applied"; number: number }
  | { kind: "same"; number: number }
  | { kind: "rejected"; reason: "stale" | "signature" | "format" | "conflict" | "halted" | "empty" };

export type ImportRejection = "format" | "signature" | "not_member" | "not_listed" | "already";

export class RelayRegistryError extends Error {
  readonly reason: ImportRejection;
  constructor(reason: ImportRejection) {
    super(reason);
    this.reason = reason;
  }
}

function atomicWrite(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, path);
}

export class RelayRegistry {
  readonly #dir: string;
  readonly #group: string;
  readonly #tlsSpki: string;
  readonly #versions = new Map<number, Stored>();
  #conflicts: RelayConflict[] = [];

  /** dir — каталог данных Ретранслятора; group — Код Группы-хозяина; tlsSpki — свой отпечаток. */
  constructor(dir: string, group: string, tlsSpki: string) {
    this.#dir = dir;
    this.#group = group;
    this.#tlsSpki = tlsSpki;
    mkdirSync(join(dir, "registry"), { recursive: true });
    for (const name of readdirSync(join(dir, "registry"))) {
      const match = /^(\d+)\.json$/.exec(name);
      if (match === null) continue;
      const stored = this.#parse(readFileSync(join(dir, "registry", name), "utf8"));
      if (stored !== undefined) this.#versions.set(stored.number, stored);
    }
    const conflicts = join(dir, "registry", "conflicts.json");
    if (existsSync(conflicts)) this.#conflicts = JSON.parse(readFileSync(conflicts, "utf8")) as RelayConflict[];
  }

  #parse(text: string): Stored | undefined {
    try {
      const doc = parseSignedDocument(text, REGISTRY_FORMAT);
      const body = parseRegistryBody(doc.body);
      // Тело — байт в байт, обвязка JSON — в одном виде, как у станции (data-model.md фичи 003).
      return { number: body.number, bodySha256: bodySha256(doc.body), body, text: serializeSignedDocument(doc), doc };
    } catch {
      return undefined;
    }
  }

  #store(stored: Stored): void {
    atomicWrite(join(this.#dir, "registry", `${stored.number}.json`), stored.text);
    this.#versions.set(stored.number, stored);
  }

  #saveConflicts(): void {
    atomicWrite(join(this.#dir, "registry", "conflicts.json"), JSON.stringify(this.#conflicts, null, 2) + "\n");
  }

  last(): Stored | undefined {
    let best: Stored | undefined;
    for (const v of this.#versions.values()) if (best === undefined || v.number > best.number) best = v;
    return best;
  }

  /** Якорь доверия: самая ранняя известная версия — установленная при relay registry import (RELAY-19). */
  #anchor(): Stored {
    let first: Stored | undefined;
    for (const v of this.#versions.values()) if (first === undefined || v.number < first.number) first = v;
    return first!;
  }

  number(): number {
    return this.last()?.number ?? 0;
  }

  halted(): boolean {
    return this.#conflicts.some((c) => c.resolvedBy === null);
  }

  /** Открытая развилка — тревога Опорной станции своей Группы (RELAY-21). */
  openConflict(): { number: number } | undefined {
    const open = this.#conflicts.find((c) => c.resolvedBy === null);
    return open === undefined ? undefined : { number: open.number };
  }

  conflicts(): readonly RelayConflict[] {
    return this.#conflicts;
  }

  /** Версии с номерами больше данного — как есть, по возрастанию (RELAY-18). */
  versionsAfter(number: number): string[] {
    return [...this.#versions.values()].filter((v) => v.number > number).sort((a, b) => a.number - b.number).map((v) => v.text);
  }

  /** Запись Группы в последней версии; нет Реестра или Группы — undefined. */
  group(code: string): RegistryGroup | undefined {
    return this.last()?.body.groups.find((g) => g.code === code);
  }

  /** Группа действует и этот Ретранслятор (по своему отпечатку) стоит в её записи (RELAY-09). */
  servesGroup(code: string): RegistryGroup | undefined {
    const group = this.group(code);
    if (group === undefined || group.state !== "active") return undefined;
    return group.relays.some((r) => r.tlsSpki === this.#tlsSpki) ? group : undefined;
  }

  /**
   * Первая версия при установке (RELAY-19): Реестра ещё нет; подпись — Ключом Координатора из неё же;
   * Группа-хозяин действует, и этот Ретранслятор стоит в её записи.
   */
  importFirst(text: string): number {
    if (this.#versions.size > 0) throw new RelayRegistryError("already");
    const stored = this.#parse(text);
    if (stored === undefined) throw new RelayRegistryError("format");
    if (signerAmong(stored.doc, stored.body.coordinatorKeys) === undefined) throw new RelayRegistryError("signature");
    const own = stored.body.groups.find((g) => g.code === this.#group);
    if (own === undefined || own.state !== "active") throw new RelayRegistryError("not_member");
    if (!own.relays.some((r) => r.tlsSpki === this.#tlsSpki)) throw new RelayRegistryError("not_listed");
    this.#store(stored);
    return stored.number;
  }

  /** Следующая версия от входящей станции — до проверки вызова (RELAY-17). */
  apply(text: string): ApplyResult {
    const last = this.last();
    if (last === undefined) return { kind: "rejected", reason: "empty" };
    const stored = this.#parse(text);
    if (stored === undefined) return { kind: "rejected", reason: "format" };
    const before = [...this.#versions.values()].filter((v) => v.number < stored.number).sort((a, b) => b.number - a.number)[0];
    const outcome = checkSuccessor(
      {
        last,
        sameNumber: this.#versions.get(stored.number),
        before,
        halted: this.halted(),
        // Версия без предшественника у Ретранслятора: доверие — только ключам установленной версии, а не
        // ключам из поступившего документа, иначе любой создал бы ложную развилку (NET-09, RELAY-11).
        firstSigner: (doc: SignedDocument) => signerAmong(doc, this.#anchor().body.coordinatorKeys),
      },
      stored.doc,
      stored.body,
      stored.bodySha256,
    );
    switch (outcome.kind) {
      case "same":
        return { kind: "same", number: stored.number };
      case "conflict": {
        const existing = this.#versions.get(stored.number)!;
        if (!this.#conflicts.some((c) => c.number === stored.number && c.bodySha256.includes(stored.bodySha256))) {
          this.#conflicts.push({ number: stored.number, bodySha256: [existing.bodySha256, stored.bodySha256], receivedAt: new Date().toISOString(), resolvedBy: null });
          this.#saveConflicts();
        }
        return { kind: "rejected", reason: "conflict" };
      }
      case "apply":
        this.#store(stored);
        if (outcome.resolvesConflict) {
          for (const c of this.#conflicts) if (c.resolvedBy === null) c.resolvedBy = stored.number;
          this.#saveConflicts();
        }
        return { kind: "applied", number: stored.number };
      case "stale":
      case "not-first":
        return { kind: "rejected", reason: "stale" };
      case "halted":
        return { kind: "rejected", reason: "halted" };
      case "signature":
        return { kind: "rejected", reason: "signature" };
    }
  }
}
