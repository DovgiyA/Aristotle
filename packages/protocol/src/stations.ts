// Виды ответов JSON API для Станций, Приглашений, параметров Группы и состояния Опорной станции
// (contracts/http-api.md фичи 004; VIEW-47, STATION-13, STATION-17, STATION-22, STATION-44).
import { Type, type Static } from "typebox";


export const StationViewState = Type.Union([Type.Literal("active"), Type.Literal("delete-only"), Type.Literal("revoked")]);
export type StationViewState = Static<typeof StationViewState>;

export const RevokeReason = Type.Union([Type.Literal("revoked"), Type.Literal("member-revoked"), Type.Literal("handover")]);
export type RevokeReason = Static<typeof RevokeReason>;

const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);

export const StationView = Type.Object({
  id: Type.String(),
  memberId: Type.String(),
  memberLabel: Type.String(),
  keyFingerprint: Type.String(),
  acceptedAt: Type.String(),
  state: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
  view: StationViewState,
  lastSession: Type.Union([Type.Object({ startedAt: Type.String(), endedAt: Nullable(Type.String()) }), Type.Null()]),
  revokedAt: Nullable(Type.String()),
  revokeReason: Type.Union([RevokeReason, Type.Null()]),
  deleteOnlyUntil: Nullable(Type.String()),
  deletionConfirmedAt: Nullable(Type.String()),
});
export type StationView = Static<typeof StationView>;

export const StationsResponse = Type.Object({ items: Type.Array(StationView) });
export type StationsResponse = Static<typeof StationsResponse>;

export const StationIdParams = Type.Object({ id: Type.String() });

export const RevokeStationRequest = Type.Object(
  { reason: Type.Union([Type.Literal("revoked"), Type.Literal("handover")]) },
  { additionalProperties: false },
);
export type RevokeStationRequest = Static<typeof RevokeStationRequest>;

export const InvitationViewState = Type.Union([
  Type.Literal("issued"),
  Type.Literal("used"),
  Type.Literal("cancelled"),
  Type.Literal("expired"),
]);

export const InvitationView = Type.Object({
  id: Type.String(),
  memberId: Type.String(),
  memberLabel: Type.String(),
  issuedBy: Type.Union([Type.Object({ id: Type.String(), label: Type.String() }), Type.Null()]),
  issuedAt: Type.String(),
  expiresAt: Type.String(),
  view: InvitationViewState,
});
export type InvitationView = Static<typeof InvitationView>;

export const InvitationsResponse = Type.Object({ items: Type.Array(InvitationView) });
export type InvitationsResponse = Static<typeof InvitationsResponse>;

export const InvitationIdParams = Type.Object({ id: Type.String() });

export const IssueInvitationRequest = Type.Object({ memberId: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
export type IssueInvitationRequest = Static<typeof IssueInvitationRequest>;

export const IssueInvitationResponse = Type.Object({
  id: Type.String(),
  memberId: Type.String(),
  expiresAt: Type.String(),
  /** Строка Приглашения выдаётся только здесь и один раз (contracts/http-api.md). */
  invitation: Type.String(),
});
export type IssueInvitationResponse = Static<typeof IssueInvitationResponse>;

export const GroupSettings = Type.Object({
  invitationHours: Type.Integer({ minimum: 1, maximum: 168 }),
  deleteOnlyDays: Type.Integer({ minimum: 1, maximum: 365 }),
});
export type GroupSettings = Static<typeof GroupSettings>;

export const GroupSettingsPatch = Type.Object(
  {
    invitationHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })),
    deleteOnlyDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type GroupSettingsPatch = Static<typeof GroupSettingsPatch>;

export const RelayLink = Type.Object({ url: Type.String(), connected: Type.Boolean(), since: Nullable(Type.String()) });
export type RelayLink = Static<typeof RelayLink>;

/** GET /api/status на API сопровождения: отпечатки, Реестр, Проходы, Станции. */
export const StatusResponse = Type.Object({
  groupKeyFingerprint: Nullable(Type.String()),
  groupKeyState: Type.Union([Type.Literal("available"), Type.Literal("unavailable"), Type.Literal("none")]),
  tlsSpki: Type.String(),
  registryNumber: Type.Union([Type.Integer(), Type.Null()]),
  halted: Type.Boolean(),
  relays: Type.Array(RelayLink),
  activeStations: Type.Integer({ minimum: 0 }),
});
export type StatusResponse = Static<typeof StatusResponse>;

