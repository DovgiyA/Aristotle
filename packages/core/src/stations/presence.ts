// Проверка подтверждения присутствия на API Станций (STATION-12; contracts/stanciya-v1.md; research
// R10 фичи 004): подпись Ключом станции сеанса над сеансом, методом, путём, хэшем тела, временем и
// nonce; не старше 60 с по часам Опорной станции, не раньше запуска процесса, nonce — один раз.
// Пароль на Опорную станцию не приходит (STATION-09): его проверила локальная часть.
import {
  PRESENCE_MAX_AGE_MS,
  decodeBytes,
  ed25519Verify,
  parsePresenceHeader,
  presenceBodyText,
  presenceMessage,
  sha256Hex,
} from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";
import type { StationSession } from "./sessions.ts";

const NONCE_MEMORY_MS = 2 * PRESENCE_MAX_AGE_MS;

export class PresenceVerifier {
  private readonly startedAt: number;
  private readonly seen = new Map<string, number>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.startedAt = clock();
  }

  /** Отказ 403 presence_required, если заголовка нет или он не подтверждает этот запрос. */
  verify(session: StationSession, header: string | undefined, method: string, path: string, body: unknown): void {
    if (header === undefined) throw new ApiError("presence_required");
    const parsed = parsePresenceHeader(header);
    if (parsed === undefined) throw new ApiError("presence_required");
    const issued = Date.parse(parsed.issuedAt);
    const now = this.clock();
    if (Number.isNaN(issued) || issued < this.startedAt || issued > now + 5_000 || now - issued > PRESENCE_MAX_AGE_MS) {
      throw new ApiError("presence_required");
    }
    const nonce = decodeBytes(parsed.nonce, 16);
    const signature = decodeBytes(parsed.signature, 64);
    if (nonce === undefined || signature === undefined) throw new ApiError("presence_required");
    const message = presenceMessage({
      sessionId: session.sessionId,
      method,
      path,
      bodySha256: sha256Hex(presenceBodyText(body)),
      issuedAt: parsed.issuedAt,
      nonce,
    });
    if (!ed25519Verify(session.stationKey, message, signature)) throw new ApiError("presence_required");
    this.forgetOld(now);
    const key = `${session.sessionId}:${parsed.nonce}`;
    if (this.seen.has(key)) throw new ApiError("presence_required");
    this.seen.set(key, now);
  }

  private forgetOld(now: number): void {
    for (const [key, at] of this.seen) if (now - at > NONCE_MEMORY_MS) this.seen.delete(key);
  }
}
