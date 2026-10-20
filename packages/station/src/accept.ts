// Приём Станции по Приглашению (STATION-13, STATION-16): разбор строки, вывод ключа Прохода и ключа
// приёма, новый Ключ станции под паролем Члена Группы, приход через Проход с подписью вызова ключом
// Прохода, внутренний TLS со сверкой отпечатка из Приглашения, POST /api/stations/accept; файлы
// пишутся только после приёма (research R7, R13 фичи 004).
import { existsSync } from "node:fs";
import { decodeBytes, deriveInvitationKeys, ed25519Sign, encodeBytes, parseInvitation, publicKeyText, type AcceptResponse } from "@aristotel/protocol";
import { BaseConnector } from "./connection.ts";
import { generateStationKey, writeStationKey } from "./station-key.ts";
import { stationKeyPath, writeStationState, type StationState } from "./station-files.ts";

export const MIN_PASSWORD_LENGTH = 12;

export class AcceptError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export interface AcceptOptions {
  dataDir: string;
  invitation: string;
  password: string;
  /** Множитель scrypt файла Ключа станции; меньше 18 — только тесты (research R19). */
  workFactor?: number;
  attemptMs?: number;
}

export interface AcceptResult extends AcceptResponse {
  stationKey: string;
  baseTlsSpki: string;
}

export async function acceptInvitation(options: AcceptOptions): Promise<AcceptResult> {
  if ([...options.password].length < MIN_PASSWORD_LENGTH) throw new AcceptError("password_weak");
  if (existsSync(stationKeyPath(options.dataDir))) throw new AcceptError("already_accepted");
  let invitation;
  try {
    invitation = parseInvitation(options.invitation);
  } catch {
    throw new AcceptError("invitation_format");
  }
  const keys = deriveInvitationKeys(decodeBytes(invitation.secret, 32)!);
  const station = generateStationKey();
  const connector = new BaseConnector({
    code: invitation.code,
    passages: invitation.passages,
    baseTlsSpki: invitation.baseTlsSpki,
    signer: { publicKey: keys.passageKey, sign: (message) => ed25519Sign(keys.passagePrivateKey, message) },
    ...(options.attemptMs === undefined ? {} : { attemptMs: options.attemptMs }),
  });
  try {
    await connector.checkApiVersion();
    const res = await connector.request("POST", "/api/stations/accept", {
      body: { invitationId: invitation.invitationId, acceptKey: encodeBytes(keys.acceptKey), stationKey: station.publicKey },
    });
    if (res.status !== 201) throw new AcceptError(String(res.json()["error"] ?? "accept_failed"), res.status);
    const accepted = res.json() as unknown as AcceptResponse;
    await writeStationKey(options.dataDir, station.key, options.password, options.workFactor);
    const state: StationState = {
      code: accepted.code,
      stationId: accepted.stationId,
      baseInstallId: accepted.installId,
      memberId: accepted.memberId,
      memberLabel: accepted.memberLabel,
      role: accepted.role,
      baseTlsSpki: invitation.baseTlsSpki,
      passages: accepted.passages.length > 0 ? accepted.passages : invitation.passages,
      acceptedAt: new Date().toISOString(),
      idleLockMinutes: 15,
    };
    writeStationState(options.dataDir, state);
    return { ...accepted, stationKey: publicKeyText(station.key), baseTlsSpki: invitation.baseTlsSpki };
  } finally {
    connector.close();
  }
}
