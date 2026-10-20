// Состояние локальной части Станции — ответ GET /local/state (contracts/lokalnaya-chast.md): один тип
// для локальной части, CLI и интерфейса в браузере (конституция V; research R15 фичи 004).
import type { Role } from "./members.ts";
import type { SignedDocument } from "./signed-document.ts";

/** То, что знает локальная часть о Станции и связи. */
export interface LocalPartState {
  accepted: boolean;
  unlocked: boolean;
  connected: boolean;
  offlineSince: string | null;
  passage: string | null;
  memberId: string | null;
  memberLabel: string | null;
  role: Role | null;
  stationKeyFingerprint: string | null;
  baseTlsSpki: string | null;
  tlsMismatch: { expected: string; seen: string } | null;
  updateRequired: boolean;
}

/** GET /local/state: состояние локальной части и блокировка интерфейса этой сессии (STATION-11). */
export interface LocalState extends LocalPartState {
  uiLocked: boolean;
}

/** POST /local/coordinator-sign: подписанная версия и подтверждение присутствия для её применения (US4.9). */
export interface CoordinatorSignResponse {
  document: SignedDocument;
  presence: string;
}

/** POST /local/presence: значение заголовка Aristotel-Presence для одного запроса (STATION-12). */
export interface PresenceResponse {
  presence: string;
}

/** POST и GET /local/ui-session: CSRF-токен сессии интерфейса (APP-06, research R14). */
export interface UiSessionResponse {
  csrf: string;
}
