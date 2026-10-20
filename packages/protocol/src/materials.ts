// Схемы JSON API Материалов (contracts/http-api.md фичи 006; data-model.md «Запись о Материале»).
// Заверение в теле — неизвестного вида: его проверяет ядро своими кодами attestation_* (research R5),
// а не общей ошибкой схемы.
import { Type, type Static } from "typebox";
import { BankRecord } from "./records.ts";
import { SHA256_PATTERN, SIZE_PATTERN } from "./zaverenie.ts";

/** Часть доставки файла (research R6): единица докачки. */
export const MATERIAL_PART_BYTES = 8 * 1024 * 1024;
/** Запас предела тела маршрута части сверх MATERIAL_PART_BYTES. */
export const MATERIAL_PART_SLACK = 64 * 1024;
/** Смещение части в байтах — заголовок PUT …/content. */
export const MATERIAL_OFFSET_HEADER = "aristotel-offset";
/** Доставка брошена, если части не приходили столько времени (research R6). */
export const MATERIAL_UPLOAD_ABANDON_MS = 60 * 60 * 1000;
/** Имя типа Записи о Материале. */
export const MATERIAL_RECORD_TYPE = "material";

const Strict = { additionalProperties: false } as const;

export const MaterialOwner = Type.Union([Type.Object({ case: Type.String({ minLength: 1 }) }, Strict), Type.Object({ document: Type.String({ minLength: 1 }) }, Strict)]);
export type MaterialOwner = Static<typeof MaterialOwner>;

export const RegisterMaterialRequest = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    owner: MaterialOwner,
    path: Type.String({ minLength: 1, maxLength: 8192 }),
    sha256: Type.String({ pattern: SHA256_PATTERN }),
    size: Type.String({ pattern: SIZE_PATTERN }),
    kind: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    attestation: Type.Unknown(),
    previousAttestations: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 16 })),
  },
  Strict,
);
export type RegisterMaterialRequest = Static<typeof RegisterMaterialRequest>;

export const MaterialIdParams = Type.Object({ id: Type.String({ minLength: 1 }) }, Strict);

export const MaterialListQuery = Type.Object(
  {
    case: Type.Optional(Type.String({ minLength: 1 })),
    document: Type.Optional(Type.String({ minLength: 1 })),
    deleted: Type.Optional(Type.Literal("include")),
  },
  Strict,
);

export const MaterialKindRequest = Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }), kind: Type.String({ minLength: 1 }) }, Strict);
export type MaterialKindRequest = Static<typeof MaterialKindRequest>;

export const MaterialDeleteRequest = Type.Object({ expectedVersion: Type.Integer({ minimum: 1 }), reason: Type.String({ minLength: 1, maxLength: 1000 }) }, Strict);
export type MaterialDeleteRequest = Static<typeof MaterialDeleteRequest>;

export const MaterialOffsetResponse = Type.Object({ received: Type.String(), size: Type.String() });
export type MaterialOffsetResponse = Static<typeof MaterialOffsetResponse>;

/** Ответ смены вида: Запись и, при выпуске образа или логической копии, предупреждение (BANK-62). */
export const MaterialKindResponse = Type.Intersect([BankRecord, Type.Object({ warning: Type.Optional(Type.Literal("material_starts_leaving")) })]);

export const MaterialListResponse = Type.Object({ items: Type.Array(BankRecord) });

/** Пометка Заверения при показе — по состоянию Станции сейчас (STATION-31). */
export type AttestationMark = null | "station_revoked" | "station_unknown";

export const MaterialAttestationsResponse = Type.Object({
  items: Type.Array(
    Type.Object({
      n: Type.Integer({ minimum: 1 }),
      current: Type.Boolean(),
      mark: Type.Union([Type.Null(), Type.Literal("station_revoked"), Type.Literal("station_unknown")]),
      receivedAt: Type.String(),
      attestation: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
});

/** Вид Записи о Материале в ответе (data-model.md «View»): не хранится. */
export interface MaterialView {
  label: string;
  delivery: "pending" | "delivered";
  deliveredAt: string | null;
  deliveredByStation: string | null;
  deleted: { at: string; by: string; reason: string } | null;
  attestations: { n: number; station: string; at: string; current: boolean; mark: AttestationMark }[];
  incomplete: ("kind" | "sha256")[];
}
