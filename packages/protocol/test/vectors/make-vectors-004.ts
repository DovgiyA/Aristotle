// Генератор векторов фичи 004 (contracts/stanciya-v1.md, contracts/prohod-v1.md): фиксированные
// семена, вызовы, EKM, nonce и время → ожидаемые строки, ключи и подписи. Запуск — один раз при смене
// формата: node packages/protocol/test/vectors/make-vectors-004.ts. Значения условные.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptKeyHash,
  deletionMessage,
  deriveInvitationKeys,
  ed25519FromSeed,
  ed25519Sign,
  encodeBytes,
  encodeInvitation,
  passageMessage,
  presenceMessage,
  publicKeyText,
  relayLoginMessage,
  sha256Hex,
  stationLoginMessage,
} from "../../src/index.ts";

const fill = (byte: number, n = 32) => new Uint8Array(n).fill(byte);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const secret = fill(0x02);
const inv = deriveInvitationKeys(secret);
const stationKey = ed25519FromSeed(fill(0x03));
const groupKey = ed25519FromSeed(fill(0x04));
const challenge = fill(0x05);
const ekm = fill(0x06);
const nonce = fill(0x07, 16);
const relaySpki = fill(0x08);

const invitation = {
  code: "A",
  invitationId: "0192a000-0000-7000-8000-000000000001",
  passages: ["https://relay-x.test:8443", "https://relay-y.test"],
  baseTlsSpki: encodeBytes(fill(0x09)),
  secret: encodeBytes(secret),
  expiresAt: "2026-10-21T12:00:00.000Z",
};
const presence = {
  sessionId: "0192a000-0000-7000-8000-000000000002",
  method: "POST",
  path: "/api/members",
  bodySha256: sha256Hex(JSON.stringify({ label: "x", role: "participant" })),
  issuedAt: "2026-10-18T10:00:00.000Z",
  nonce,
};
const login = stationLoginMessage(challenge, ekm);
const presenceMsg = presenceMessage(presence);
const deletion = deletionMessage("0192a000-0000-7000-8000-000000000003", "0192a000-0000-7000-8000-000000000004");
const relayLogin = relayLoginMessage("A", challenge, relaySpki);
const passage = passageMessage("A", challenge);

const stanciya = {
  secretSeedByte: 2,
  invitation,
  invitationString: encodeInvitation(invitation),
  passageKey: inv.passageKey,
  acceptKey: encodeBytes(inv.acceptKey),
  acceptKeyHash: acceptKeyHash(inv.acceptKey),
  stationKeySeedByte: 3,
  stationKey: publicKeyText(stationKey),
  login: { challenge: encodeBytes(challenge), ekm: encodeBytes(ekm), message: hex(login), signature: encodeBytes(ed25519Sign(stationKey, login)) },
  presence: { ...presence, nonce: encodeBytes(nonce), message: hex(presenceMsg), signature: encodeBytes(ed25519Sign(stationKey, presenceMsg)) },
  deletion: { stationId: "0192a000-0000-7000-8000-000000000003", commandId: "0192a000-0000-7000-8000-000000000004", message: hex(deletion), signature: encodeBytes(ed25519Sign(stationKey, deletion)) },
};
const prohod = {
  groupKeySeedByte: 4,
  groupKey: publicKeyText(groupKey),
  relayLogin: { code: "A", challenge: encodeBytes(challenge), relayTlsSpki: encodeBytes(relaySpki), message: hex(relayLogin), signature: encodeBytes(ed25519Sign(groupKey, relayLogin)) },
  passage: { code: "A", challenge: encodeBytes(challenge), message: hex(passage), signatureByPassageKey: encodeBytes(ed25519Sign(inv.passagePrivateKey, passage)) },
};
writeFileSync(join(import.meta.dirname, "stanciya-v1.json"), JSON.stringify(stanciya, null, 2) + "\n");
writeFileSync(join(import.meta.dirname, "prohod-v1.json"), JSON.stringify(prohod, null, 2) + "\n");
