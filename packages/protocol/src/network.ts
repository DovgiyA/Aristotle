// Виды ответов JSON API для Ключа Группы, Реестра Сети и Ключей Координатора
// (contracts/http-api.md фичи 003; NET-41, NET-42, NET-53, FR-016).
import { Type, type Static } from "typebox";
import { RegistryBodySchema } from "./registry.ts";
import { RelayLink } from "./stations.ts";

export const GroupKeyInfo = Type.Object({
  signingKey: Type.String(),
  encryptionKey: Type.String(),
  keyFingerprint: Type.String(),
  createdAt: Type.String(),
  /** unavailable — секретной части нет или она не читается, а Реестр применён (NET-53). */
  state: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
});
export type GroupKeyInfo = Static<typeof GroupKeyInfo>;

// id = null — служба Опорной станции: версию отдал Ретранслятор при входе (RELAY-18, фича 004).
const MemberRef = Type.Object({ id: Type.Union([Type.String(), Type.Null()]), label: Type.String() });

export const RegistryCurrent = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  bodySha256: Type.String(),
  appliedAt: Type.String(),
  appliedBy: MemberRef,
  signedBy: Type.Object({ key: Type.String(), keyFingerprint: Type.String() }),
  body: RegistryBodySchema,
  coordinatorKeyFingerprints: Type.Array(Type.String()),
});
export type RegistryCurrent = Static<typeof RegistryCurrent>;

export const RegistryConflict = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  bodySha256: Type.String(),
  receivedAt: Type.String(),
  resolvedBy: Type.Union([Type.Integer(), Type.Null()]),
});
export type RegistryConflict = Static<typeof RegistryConflict>;

export const RegistryState = Type.Object({
  current: Type.Union([RegistryCurrent, Type.Null()]),
  halted: Type.Boolean(),
  conflicts: Type.Array(RegistryConflict),
  /** Отпечаток TLS Опорной станции и состояние её Проходов (фича 004, contracts/http-api.md). */
  baseTlsSpki: Type.Optional(Type.String()),
  relays: Type.Optional(Type.Array(RelayLink)),
});
export type RegistryState = Static<typeof RegistryState>;

export const RegistryNumberParams = Type.Object({ number: Type.Integer({ minimum: 1 }) });

export const CoordinatorKeyItem = Type.Object({
  id: Type.String(),
  publicKey: Type.String(),
  keyFingerprint: Type.String(),
  member: MemberRef,
  state: Type.Union([Type.Literal("registered"), Type.Literal("withdrawn")]),
  registeredAt: Type.String(),
  withdrawnAt: Type.Union([Type.String(), Type.Null()]),
  inCurrentRegistry: Type.Boolean(),
});
export type CoordinatorKeyItem = Static<typeof CoordinatorKeyItem>;

export const CoordinatorKeysResponse = Type.Object({ items: Type.Array(CoordinatorKeyItem) });
export type CoordinatorKeysResponse = Static<typeof CoordinatorKeysResponse>;
