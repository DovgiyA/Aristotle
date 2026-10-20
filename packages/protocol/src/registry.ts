// Документ версии Реестра Сети `aristotel/reestr/v1`: схема тела, Код Группы, адреса Ретрансляторов,
// запросы черновика и регистрации Ключа Координатора (NET-04, NET-06, NET-41, NET-51, RELAY-16;
// contracts/reestr-v1.md; research R5, R7, R8, R13 фичи 003).
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { Encrypter } from "age-encryption";
import { decodeKey } from "./key-fingerprint.ts";

export const REGISTRY_FORMAT = "aristotel/reestr/v1";

/** Код Группы: от 1 до 8 знаков, заглавные латинские буквы и цифры, первый — буква (NET-51). */
export const GROUP_CODE_PATTERN = /^[A-Z][A-Z0-9]{0,7}$/;

export function isGroupCode(code: string): boolean {
  return GROUP_CODE_PATTERN.test(code);
}

/** Состояния членства в Реестре (NET-04). */
export const MEMBERSHIP_STATES = ["active", "suspended", "excluded"] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

export const MAX_COORDINATOR_KEYS = 8;
export const MAX_RELAYS = 8;

export const RelaySchema = Type.Object(
  { url: Type.String({ minLength: 1 }), tlsSpki: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type Relay = Static<typeof RelaySchema>;

export const RegistryGroupSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    signingKey: Type.String(),
    encryptionKey: Type.String(),
    state: Type.Union([Type.Literal("active"), Type.Literal("suspended"), Type.Literal("excluded")]),
    relays: Type.Array(RelaySchema, { maxItems: MAX_RELAYS }),
  },
  { additionalProperties: false },
);
export type RegistryGroup = Static<typeof RegistryGroupSchema>;

export const RegistryBodySchema = Type.Object(
  {
    number: Type.Integer({ minimum: 1 }),
    issuedAt: Type.String({ minLength: 1 }),
    coordinatingGroup: Type.String({ minLength: 1 }),
    coordinatorKeys: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_COORDINATOR_KEYS }),
    groups: Type.Array(RegistryGroupSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type RegistryBody = Static<typeof RegistryBodySchema>;

/** Отказ разбора тела: format — не по схеме, code_format — Код не по NET-51, no_relay — NET-17. */
export class RegistryFormatError extends Error {
  readonly reason: "format" | "code_format" | "no_relay";
  constructor(reason: "format" | "code_format" | "no_relay", detail: string) {
    super(detail);
    this.reason = reason;
  }
}

/** Строка получателя age X25519 `age1…` с верной контрольной суммой; гибридные и прочие — нет. */
export function isAgeX25519Recipient(text: string): boolean {
  if (!text.startsWith("age1") || text.startsWith("age1pq1") || text.startsWith("age1tag1") || text.startsWith("age1tagpq1")) {
    return false;
  }
  try {
    new Encrypter().addRecipient(text);
    return true;
  } catch {
    return false;
  }
}

/** Адрес Ретранслятора: `https://<имя или IP>[:<порт>]` без пути, параметров и учётных данных (R13). */
export function isRelayUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.host !== "" && text === `https://${url.host}`;
}

function fail(detail: string): never {
  throw new RegistryFormatError("format", detail);
}

/** Разобрать и проверить тело версии Реестра по contracts/reestr-v1.md. */
export function parseRegistryBody(body: string): RegistryBody {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    fail("body is not JSON");
  }
  if (!Value.Check(RegistryBodySchema, value)) fail("body schema");
  const parsed = value as RegistryBody;
  const keys = new Set<string>();
  for (const key of parsed.coordinatorKeys) {
    if (decodeKey(key) === undefined || keys.has(key)) fail("coordinatorKeys");
    keys.add(key);
  }
  const codes = new Set<string>();
  let badCode = false;
  for (const group of parsed.groups) {
    if (codes.has(group.code)) fail("groups: code repeated");
    codes.add(group.code);
    if (!isGroupCode(group.code)) badCode = true;
    if (decodeKey(group.signingKey) === undefined) fail("signingKey");
    if (!isAgeX25519Recipient(group.encryptionKey)) fail("encryptionKey");
    if (group.state === "active" && group.relays.length === 0) throw new RegistryFormatError("no_relay", "relays");
    const urls = new Set<string>();
    for (const relay of group.relays) {
      if (!isRelayUrl(relay.url) || urls.has(relay.url)) fail("relay url");
      urls.add(relay.url);
      if (decodeKey(relay.tlsSpki) === undefined) fail("tlsSpki");
    }
  }
  if (!codes.has(parsed.coordinatingGroup)) fail("coordinatingGroup");
  if (badCode || !isGroupCode(parsed.coordinatingGroup)) throw new RegistryFormatError("code_format", "code");
  return parsed;
}

/** POST /api/registry/draft (research R8). */
export const DraftRequest = Type.Object(
  {
    code: Type.Optional(Type.String({ minLength: 1 })),
    addRelays: Type.Optional(Type.Array(RelaySchema, { maxItems: MAX_RELAYS })),
    removeRelays: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: MAX_RELAYS })),
  },
  { additionalProperties: false },
);
export type DraftRequest = Static<typeof DraftRequest>;

/** POST /api/coordinator-keys (research R7). */
export const CoordinatorKeyRegisterRequest = Type.Object(
  { publicKey: Type.String({ minLength: 1 }), proof: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type CoordinatorKeyRegisterRequest = Static<typeof CoordinatorKeyRegisterRequest>;

/** Тег доказательства владения Ключом Координатора при регистрации (research R7). */
export const COORDINATOR_KEY_PROOF_FORMAT = "aristotel/klyuch-koordinatora/registraciya/v1";

/** Сообщение доказательства: тег ‖ 0x00 ‖ installId ‖ 0x00 ‖ memberId. */
export function coordinatorKeyProofMessage(installId: string, memberId: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(COORDINATOR_KEY_PROOF_FORMAT, "utf8"),
      Buffer.from([0]),
      Buffer.from(installId, "utf8"),
      Buffer.from([0]),
      Buffer.from(memberId, "utf8"),
    ]),
  );
}
