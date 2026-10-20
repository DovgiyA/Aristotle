// Коды ошибок JSON API — по таблице contracts/http-api.md.
import { Type, type Static } from "typebox";

export const ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  unknown_member: 403,
  forbidden: 403,
  member_revoked: 403,
  not_found: 404,
  version_conflict: 409,
  already_bootstrapped: 409,
  senior_limit: 409,
  last_senior: 409,
  member_not_active: 409,
  group_key_unavailable: 409,
  registry_stale: 409,
  registry_conflict: 409,
  registry_halted: 409,
  coordinator_key_exists: 409,
  coordinator_key_missing: 409,
  registry_rejected: 422,
  coordinator_key_proof_invalid: 422,
  // Фича 004: сеанс Станции, присутствие, API сопровождения, Приглашения, Станции (contracts/http-api.md).
  session_required: 401,
  presence_required: 403,
  station_delete_only: 403,
  maintenance_only: 403,
  invitation_self: 403,
  invitation_invalid: 403,
  station_unknown: 403,
  invitation_senior_has_station: 409,
  invitation_not_issued: 409,
  station_not_active: 409,
  station_key_taken: 409,
  network_not_launched: 409,
  // Фича 005: модель данных, Словарь Сети, Местное расширение (contracts/http-api.md фичи 005).
  model_invalid: 400,
  case_required: 400,
  dictionary_missing: 409,
  case_counter_behind: 409,
  proposal_not_open: 409,
  dictionary_rejected: 422,
  local_weakening: 422,
  // Фича 006: Материалы, Заверение, доставка (contracts/http-api.md фичи 006).
  material_path_invalid: 400,
  material_path_reserved: 400,
  material_path_taken: 409,
  material_id_taken: 409,
  case_not_draft: 409,
  material_use_material_routes: 403,
  material_kind_release: 403,
  attestation_invalid: 400,
  attestation_signature: 422,
  attestation_mismatch: 422,
  attestation_key_mismatch: 422,
  attestation_station_unknown: 409,
  attestation_station_revoked: 409,
  attestation_previous_valid: 409,
  attestation_session_station: 422,
  delivery_station: 403,
  delivery_held: 409,
  delivery_offset: 409,
  delivery_done: 409,
  delivery_not_done: 409,
  material_deleted: 409,
  delivery_part_too_large: 413,
  delivery_hash_mismatch: 422,
  delivery_no_space: 507,
  material_kind_unknown: 422,
  material_kind_converter_only: 403,
  material_kind_owner: 422,
  secret_crypto_task: 409,
  material_file_unreadable: 422,
  material_file_not_regular: 422,
  // Локальная часть Станции (contracts/lokalnaya-chast.md).
  host_rejected: 421,
  ui_session_required: 401,
  csrf_rejected: 403,
  password_wrong: 403,
  station_deleted: 410,
  password_weak: 422,
  ui_locked: 423,
  station_locked: 423,
  api_version_incompatible: 426,
  internal_error: 500,
  storage_unavailable: 503,
  offline: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ErrorBody = Type.Object(
  {
    error: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: true },
);

export type ErrorBody = Static<typeof ErrorBody>;

export const VersionInfo = Type.Object({
  apiVersions: Type.Array(Type.Integer()),
  role: Type.String(),
  programVersion: Type.String(),
});

export type VersionInfo = Static<typeof VersionInfo>;
