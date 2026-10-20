// Правила применения версии Реестра, общие для станции и Ретранслятора (research R3 фичи 004):
// номер больше известного и подпись Ключом Координатора из последней известной версии (NET-09);
// другая версия с известным номером — развилка (NET-12, RELAY-21); остановку снимает следующая
// версия по NET-52 и RELAY-25. Содержимое (своя запись, Ключи Группы) проверяет каждая сторона сама.
import { verifySignature, type SignedDocument } from "./signed-document.ts";
import type { RegistryBody } from "./registry.ts";

export interface KnownVersion {
  number: number;
  bodySha256: string;
  body: RegistryBody;
}

export interface SuccessorContext {
  /** Последняя применённая версия. */
  last?: KnownVersion | undefined;
  /** Применённая версия с тем же номером, что у новой. */
  sameNumber?: KnownVersion | undefined;
  /** Применённая версия с наибольшим номером меньше номера новой. */
  before?: KnownVersion | undefined;
  /** Есть открытая развилка. */
  halted: boolean;
  /** Ключ, которым подписана версия 1 (и другая версия 1), — правило стороны. */
  firstSigner: (doc: SignedDocument, body: RegistryBody) => string | undefined;
}

export type SuccessorOutcome =
  | { kind: "same" }
  | { kind: "conflict"; signer: string }
  | { kind: "stale" }
  | { kind: "not-first" }
  | { kind: "halted" }
  | { kind: "signature" }
  | { kind: "apply"; signer: string; resolvesConflict: boolean };

/** Ключ из списка, которым подпись документа проверяется; нет такого — undefined. */
export function signerAmong(doc: SignedDocument, keys: Iterable<string>): string | undefined {
  for (const key of keys) if (verifySignature(doc, key)) return key;
  return undefined;
}

/** NET-52, RELAY-25: в версии одна действующая Группа, и она Координирующая. */
export function singleGroupNetwork(body: RegistryBody): boolean {
  const active = body.groups.filter((g) => g.state === "active");
  return active.length === 1 && active[0]?.code === body.coordinatingGroup;
}

export function checkSuccessor(ctx: SuccessorContext, doc: SignedDocument, body: RegistryBody, hash: string): SuccessorOutcome {
  const { last } = ctx;
  if (ctx.sameNumber !== undefined && last !== undefined) {
    if (ctx.sameNumber.bodySha256 === hash) return { kind: "same" };
    const signer = ctx.before === undefined ? ctx.firstSigner(doc, body) : signerAmong(doc, ctx.before.body.coordinatorKeys);
    return signer === undefined ? { kind: "signature" } : { kind: "conflict", signer };
  }
  if (last !== undefined && body.number <= last.number) return { kind: "stale" };
  if (last === undefined && body.number !== 1) return { kind: "not-first" };
  const signer = last === undefined ? ctx.firstSigner(doc, body) : signerAmong(doc, last.body.coordinatorKeys);
  if (ctx.halted && !(last !== undefined && signer !== undefined && singleGroupNetwork(last.body))) return { kind: "halted" };
  if (signer === undefined) return { kind: "signature" };
  return { kind: "apply", signer, resolvesConflict: ctx.halted };
}
