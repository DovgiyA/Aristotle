// Вход Опорной станции на Ретранслятор подписанным вызовом Ключом Группы (RELAY-08, RELAY-17,
// RELAY-18, RELAY-21; contracts/prohod-v1.md; research R4 фичи 004). Вызовы и токены — только в
// памяти; ответы об отказе — без подробностей.
import { randomBytes } from "node:crypto";
import {
  RELAY_CHALLENGE_TTL_MS,
  RELAY_TOKEN_TTL_MS,
  decodeBytes,
  ed25519Verify,
  encodeBytes,
  relayLoginMessage,
  type RelayLoginRequest,
  type RelayLoginResponse,
} from "@aristotel/protocol";
import type { RelayRegistry } from "./registry.ts";

export class ChallengeStore {
  readonly #items = new Map<string, number>();
  readonly #ttl: number;
  constructor(ttl = RELAY_CHALLENGE_TTL_MS) {
    this.#ttl = ttl;
  }

  issue(): { challenge: string; expiresAt: string } {
    const now = Date.now();
    for (const [key, until] of this.#items) if (until < now) this.#items.delete(key);
    const challenge = encodeBytes(randomBytes(32));
    const until = now + this.#ttl;
    this.#items.set(challenge, until);
    return { challenge, expiresAt: new Date(until).toISOString() };
  }

  /** Вызов есть и не истёк; consume — потратить. */
  check(challenge: string, consume: boolean): boolean {
    const until = this.#items.get(challenge);
    if (until === undefined || until < Date.now()) return false;
    if (consume) this.#items.delete(challenge);
    return true;
  }
}

export class TokenStore {
  readonly #tokens = new Map<string, { code: string; until: number }>();
  readonly #ttl: number;
  constructor(ttl = RELAY_TOKEN_TTL_MS) {
    this.#ttl = ttl;
  }

  issue(code: string): { token: string; expiresAt: string } {
    const now = Date.now();
    for (const [key, item] of this.#tokens) if (item.until < now) this.#tokens.delete(key);
    const token = encodeBytes(randomBytes(32));
    const until = now + this.#ttl;
    this.#tokens.set(token, { code, until });
    return { token, expiresAt: new Date(until).toISOString() };
  }

  /** Код Группы токена; нет или истёк — undefined. */
  codeOf(token: string): string | undefined {
    const item = this.#tokens.get(token);
    return item === undefined || item.until < Date.now() ? undefined : item.code;
  }
}

export type LoginOutcome =
  | { kind: "ok"; body: RelayLoginResponse }
  | { kind: "registry_needed"; registryNumber: number }
  | { kind: "forbidden" };

export interface LoginContext {
  registry: RelayRegistry;
  challenges: ChallengeStore;
  tokens: TokenStore;
  /** SHA-256 SPKI этого Ретранслятора, 32 байта. */
  tlsSpki: Uint8Array;
  /** Код Группы-хозяина: только ей Ретранслятор отдаёт тревогу о развилке (RELAY-21). */
  ownGroup: string;
}

/** POST /relay/v1/vhod — порядок проверок по contracts/prohod-v1.md. */
export function login(ctx: LoginContext, request: RelayLoginRequest): LoginOutcome {
  const relayNumber = ctx.registry.number();
  if (request.registryNumber > relayNumber) return { kind: "registry_needed", registryNumber: relayNumber };
  if (!ctx.challenges.check(request.challenge, false)) return { kind: "forbidden" };
  const group = ctx.registry.servesGroup(request.code);
  const challenge = decodeBytes(request.challenge, 32);
  const signature = decodeBytes(request.signature, 64);
  if (group === undefined || challenge === undefined || signature === undefined) return { kind: "forbidden" };
  if (!ed25519Verify(group.signingKey, relayLoginMessage(request.code, challenge, ctx.tlsSpki), signature)) return { kind: "forbidden" };
  ctx.challenges.check(request.challenge, true);
  const issued = ctx.tokens.issue(request.code);
  const body: RelayLoginResponse = { token: issued.token, expiresAt: issued.expiresAt, registryNumber: relayNumber };
  const versions = ctx.registry.versionsAfter(request.registryNumber);
  if (versions.length > 0) body.versions = versions;
  const conflict = ctx.registry.openConflict();
  if (conflict !== undefined && request.code === ctx.ownGroup) body.conflict = conflict;
  return { kind: "ok", body };
}
