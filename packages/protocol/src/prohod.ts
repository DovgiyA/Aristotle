// Протокол Ретранслятора: вход Опорной станции Ключом Группы, обмен версиями Реестра, управляющее
// соединение, Проход для Станции (contracts/prohod-v1.md; RELAY-08, RELAY-17, RELAY-18, RELAY-21,
// STATION-02, STATION-04; research R4, R5 фичи 004).
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { taggedMessage } from "./tagged-message.ts";

export const RELAY_LOGIN_TAG = "aristotel/vhod-retranslyatora/v1";
export const PASSAGE_TAG = "aristotel/prohod/v1";
export const UPGRADE_CONTROL = "aristotel-prohod-upravlenie/1";
export const UPGRADE_PASSAGE = "aristotel-prohod/1";
export const PASSAGE_KEY_HEADER = "aristotel-key";
export const PASSAGE_CHALLENGE_HEADER = "aristotel-challenge";
export const PASSAGE_SIGNATURE_HEADER = "aristotel-signature";

export const RELAY_TOKEN_TTL_MS = 15 * 60 * 1000;
export const RELAY_CHALLENGE_TTL_MS = 30 * 1000;
export const SPLICE_WAIT_MS = 10 * 1000;
export const CONTROL_PING_MS = 20 * 1000;
export const CONTROL_SILENCE_MS = 60 * 1000;
export const RELAY_MAX_BODY = 1024 * 1024;

/** Коды ошибок Ретранслятора — без текста для людей (contracts/prohod-v1.md). */
export const RELAY_ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  registry_needed: 409,
  registry_rejected: 409,
  slow_down: 429,
} as const;
export type RelayErrorCode = keyof typeof RELAY_ERROR_STATUS;

/** Вход на Ретранслятор: подпись Ключом Группы над Кодом, вызовом и отпечатком TLS Ретранслятора (RELAY-08). */
export function relayLoginMessage(code: string, challenge: Uint8Array, relayTlsSpki: Uint8Array): Uint8Array {
  return taggedMessage(RELAY_LOGIN_TAG, code, challenge, relayTlsSpki);
}

/** Вызов Прохода: подпись Ключом станции или ключом Прохода Приглашения (STATION-04). */
export function passageMessage(code: string, challenge: Uint8Array): Uint8Array {
  return taggedMessage(PASSAGE_TAG, code, challenge);
}

export const RelayChallenge = Type.Object({ challenge: Type.String(), expiresAt: Type.String() });
export type RelayChallenge = Static<typeof RelayChallenge>;

export const RelayLoginRequest = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 8 }),
    registryNumber: Type.Integer({ minimum: 0 }),
    challenge: Type.String({ minLength: 1, maxLength: 64 }),
    signature: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type RelayLoginRequest = Static<typeof RelayLoginRequest>;

export const RelayLoginResponse = Type.Object(
  {
    token: Type.String(),
    expiresAt: Type.String(),
    registryNumber: Type.Integer(),
    versions: Type.Optional(Type.Array(Type.String())),
    conflict: Type.Optional(Type.Object({ number: Type.Integer() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);
export type RelayLoginResponse = Static<typeof RelayLoginResponse>;

export const PassageKeyEntry = Type.Union([
  Type.Object(
    {
      key: Type.String({ minLength: 43, maxLength: 43 }),
      kind: Type.Literal("station"),
      state: Type.Union([Type.Literal("active"), Type.Literal("delete-only")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { key: Type.String({ minLength: 43, maxLength: 43 }), kind: Type.Literal("invitation"), expiresAt: Type.String() },
    { additionalProperties: false },
  ),
]);
export type PassageKeyEntry = Static<typeof PassageKeyEntry>;

export const ControlMessage = Type.Union([
  Type.Object({ type: Type.Literal("passage-list"), keys: Type.Array(PassageKeyEntry) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("call"), callId: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("ping") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("pong") }, { additionalProperties: false }),
]);
export type ControlMessage = Static<typeof ControlMessage>;

/** Разобрать строку управляющего соединения; не по схеме — undefined. */
export function parseControlMessage(line: string): ControlMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return Value.Check(ControlMessage, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
