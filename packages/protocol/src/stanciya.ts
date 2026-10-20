// Форматы между Станцией и Опорной станцией внутри Прохода: строка Приглашения, вход Станции,
// подтверждение присутствия, команда удаления, события Станции (contracts/stanciya-v1.md;
// STATION-10, STATION-12, STATION-13, STATION-16, STATION-22, STATION-42; research R7, R8, R10, R11
// фичи 004). Вывод ключей из секрета Приглашения — node/stanciya-keys.ts (только роли на Node).
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { decodeKey } from "./key-fingerprint.ts";
import { taggedMessage } from "./tagged-message.ts";
import { RoleSchema } from "./members.ts";

export const INVITATION_PREFIX = "aristotel-priglashenie-v1:";
export const INVITATION_INFO_PASSAGE = "aristotel/priglashenie/prohod";
export const INVITATION_INFO_ACCEPT = "aristotel/priglashenie/priem";
export const STATION_LOGIN_TAG = "aristotel/vhod-stancii/v1";
export const PRESENCE_TAG = "aristotel/prisutstvie/v1";
export const DELETION_TAG = "aristotel/udalenie/v1";
/** Метка exportKeyingMaterial внутреннего TLS: вход Станции привязан к каналу (research R8). */
export const STATION_EKM_LABEL = "EXPORTER-aristotel-vhod-stancii";

export const SESSION_TTL_MS = 15 * 60 * 1000;
export const SESSION_RENEW_BEFORE_MS = 5 * 60 * 1000;
export const CHALLENGE_TTL_MS = 30 * 1000;
export const PRESENCE_MAX_AGE_MS = 60 * 1000;
export const PRESENCE_HEADER = "aristotel-presence";
export const MAX_PASSAGES = 8;

const Key32 = Type.String({ pattern: "^[A-Za-z0-9+/]{43}$" });

export const InvitationSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 8 }),
    invitationId: Type.String({ minLength: 1, maxLength: 64 }),
    passages: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: MAX_PASSAGES }),
    baseTlsSpki: Key32,
    secret: Key32,
    expiresAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type Invitation = Static<typeof InvitationSchema>;

export class InvitationFormatError extends Error {}

function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** Строка Приглашения: префикс и base64url от JSON (contracts/stanciya-v1.md). */
export function encodeInvitation(invitation: Invitation): string {
  return INVITATION_PREFIX + toBase64Url(JSON.stringify(invitation));
}

/** Разобрать строку Приглашения; пробелы по краям и перевод строки файла допускаются. */
export function parseInvitation(text: string): Invitation {
  const trimmed = text.trim();
  if (!trimmed.startsWith(INVITATION_PREFIX)) throw new InvitationFormatError("prefix");
  const payload = trimmed.slice(INVITATION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new InvitationFormatError("base64url");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new InvitationFormatError("json");
  }
  if (!Value.Check(InvitationSchema, parsed)) throw new InvitationFormatError("schema");
  if (decodeKey(parsed.secret) === undefined || decodeKey(parsed.baseTlsSpki) === undefined) throw new InvitationFormatError("key");
  return parsed;
}

/** Вход Станции: подпись над вызовом Опорной станции и EKM этого TLS-соединения (STATION-10). */
export function stationLoginMessage(challenge: Uint8Array, ekm: Uint8Array): Uint8Array {
  return taggedMessage(STATION_LOGIN_TAG, challenge, ekm);
}

export interface PresenceFields {
  sessionId: string;
  method: string;
  /** Путь без параметров запроса. */
  path: string;
  /** SHA-256 текста тела в hex строчными — presenceBodyText. */
  bodySha256: string;
  issuedAt: string;
  nonce: Uint8Array;
}

/**
 * Текст тела для хэша подтверждения: JSON.stringify разобранного тела, без тела — пустая строка.
 * Обе стороны считают от значения, а не от байтов запроса (отступление T010, «Итоги реализации»).
 */
export function presenceBodyText(body: unknown): string {
  return body === undefined || body === null ? "" : JSON.stringify(body);
}

/** Подтверждение присутствия: сеанс, метод, путь, тело, время, nonce (STATION-12). */
export function presenceMessage(fields: PresenceFields): Uint8Array {
  return taggedMessage(PRESENCE_TAG, fields.sessionId, fields.method.toUpperCase(), fields.path, fields.bodySha256, fields.issuedAt, fields.nonce);
}

export const PresenceHeaderSchema = Type.Object(
  { issuedAt: Type.String({ minLength: 1 }), nonce: Type.String({ minLength: 1 }), signature: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type PresenceHeader = Static<typeof PresenceHeaderSchema>;

export function encodePresenceHeader(header: PresenceHeader): string {
  return toBase64Url(JSON.stringify(header));
}

export function parsePresenceHeader(text: string): PresenceHeader | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    return Value.Check(PresenceHeaderSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Подтверждение команды удаления Ключом станции (STATION-22). */
export function deletionMessage(stationId: string, commandId: string): Uint8Array {
  return taggedMessage(DELETION_TAG, stationId, commandId);
}

// --- Схемы API Станций (contracts/stanciya-v1.md, contracts/http-api.md) ---

export const AcceptRequest = Type.Object(
  { invitationId: Type.String({ minLength: 1, maxLength: 64 }), acceptKey: Key32, stationKey: Key32 },
  { additionalProperties: false },
);
export type AcceptRequest = Static<typeof AcceptRequest>;

export const AcceptResponse = Type.Object({
  stationId: Type.String(),
  /** Установка Опорной станции — для доказательства владения Ключом Координатора (research R7 фичи 003). */
  installId: Type.String(),
  memberId: Type.String(),
  memberLabel: Type.String(),
  role: RoleSchema,
  code: Type.String(),
  passages: Type.Array(Type.String()),
});
export type AcceptResponse = Static<typeof AcceptResponse>;

export const ChallengeResponse = Type.Object({ challenge: Type.String(), expiresAt: Type.String() });
export type ChallengeResponse = Static<typeof ChallengeResponse>;

export const SessionRequest = Type.Object(
  { stationKey: Key32, challenge: Type.String({ minLength: 1, maxLength: 64 }), signature: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
export type SessionRequest = Static<typeof SessionRequest>;

export const SessionScope = Type.Union([Type.Literal("full"), Type.Literal("delete-only")]);
export type SessionScope = Static<typeof SessionScope>;

export const SessionResponse = Type.Object({
  sessionId: Type.String(),
  token: Type.String(),
  expiresAt: Type.String(),
  scope: SessionScope,
  stationId: Type.String(),
  memberId: Type.String(),
  role: RoleSchema,
  passages: Type.Array(Type.String()),
});
export type SessionResponse = Static<typeof SessionResponse>;

export const DeletionCommand = Type.Object({ commandId: Type.String(), items: Type.Array(Type.String()) });
export type DeletionCommand = Static<typeof DeletionCommand>;

export const DeletionConfirmRequest = Type.Object(
  { commandId: Type.String({ minLength: 1, maxLength: 64 }), signature: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
export type DeletionConfirmRequest = Static<typeof DeletionConfirmRequest>;

export const StationEventsQuery = Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export const StationEventsResponse = Type.Object({ seq: Type.Integer(), passages: Type.Array(Type.String()) });
export type StationEventsResponse = Static<typeof StationEventsResponse>;
