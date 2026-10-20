// Схемы Члена Группы, заведения первого Старшего и ведения состава Группы
// (ROLE-03, ROLE-08, ROLE-21, ROLE-26, ROLE-36, STATION-17; data-model.md «member»).
import { Type, type Static } from "typebox";

/** Роли Члена Группы — Участник, Старший Группы, Наблюдатель (ROLE-03). */
export const ROLES = ["participant", "senior", "observer"] as const;
export type Role = (typeof ROLES)[number];

/** Состояния Члена Группы — действует, отозван (ROLE-32, ROLE-33, STATION-17). */
export const MEMBER_STATES = ["active", "revoked"] as const;
export type MemberState = (typeof MEMBER_STATES)[number];

export const RoleSchema = Type.Union([Type.Literal("participant"), Type.Literal("senior"), Type.Literal("observer")]);

export const Member = Type.Object({
  id: Type.String(),
  label: Type.String({ minLength: 1 }),
  role: RoleSchema,
  state: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
  version: Type.Integer({ minimum: 1 }),
  createdAt: Type.String(),
});

export type Member = Static<typeof Member>;

export const MembersResponse = Type.Object({ items: Type.Array(Member) });

export type MembersResponse = Static<typeof MembersResponse>;

export const MemberIdParams = Type.Object({ id: Type.String() });

export const BootstrapRequest = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    osAccount: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type BootstrapRequest = Static<typeof BootstrapRequest>;

export const CreateMemberRequest = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    role: RoleSchema,
  },
  { additionalProperties: false },
);

export type CreateMemberRequest = Static<typeof CreateMemberRequest>;

/** Смена роли или подписи: хотя бы одно из полей — проверяет ядро (contracts/http-api.md). */
export const UpdateMemberRequest = Type.Object(
  {
    expectedVersion: Type.Integer({ minimum: 1 }),
    role: Type.Optional(RoleSchema),
    label: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type UpdateMemberRequest = Static<typeof UpdateMemberRequest>;

export const RevokeMemberRequest = Type.Object(
  { expectedVersion: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export type RevokeMemberRequest = Static<typeof RevokeMemberRequest>;
