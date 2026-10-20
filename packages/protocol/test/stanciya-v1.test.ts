// T006 — контракт contracts/stanciya-v1.md с векторами: строка Приглашения, вывод ключа Прохода и
// ключа приёма, подписываемые сообщения входа, присутствия и удаления (research R7, R8, R10, R11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  InvitationFormatError,
  acceptKeyHash,
  decodeBytes,
  deletionMessage,
  deriveInvitationKeys,
  ed25519FromSeed,
  ed25519Verify,
  encodeBytes,
  encodeInvitation,
  encodePresenceHeader,
  parseInvitation,
  parsePresenceHeader,
  presenceBodyText,
  presenceMessage,
  publicKeyText,
  stationLoginMessage,
  type Invitation,
} from "../src/index.ts";

const V = JSON.parse(readFileSync(join(import.meta.dirname, "vectors", "stanciya-v1.json"), "utf8"));
const fill = (byte: number, n = 32) => new Uint8Array(n).fill(byte);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** Сообщение, собранное независимо от модуля: тег, 0x00, поля через 0x00. */
const manual = (tag: string, ...fields: (string | Uint8Array)[]) =>
  Buffer.concat([Buffer.from(tag), ...fields.flatMap((f) => [Buffer.from([0]), Buffer.from(f)])]).toString("hex");

test("ключ Прохода и ключ приёма — HKDF-SHA256 от секрета с info по контракту", () => {
  const secret = fill(V.secretSeedByte);
  const keys = deriveInvitationKeys(secret);
  const passageSeed = new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), "aristotel/priglashenie/prohod", 32));
  const acceptKey = new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), "aristotel/priglashenie/priem", 32));
  assert.equal(keys.passageKey, publicKeyText(ed25519FromSeed(passageSeed)));
  assert.equal(keys.passageKey, V.passageKey);
  assert.equal(encodeBytes(keys.acceptKey), V.acceptKey);
  assert.equal(encodeBytes(acceptKey), V.acceptKey);
  assert.equal(acceptKeyHash(keys.acceptKey), createHash("sha256").update(acceptKey).digest("hex"));
  assert.equal(acceptKeyHash(keys.acceptKey), V.acceptKeyHash);
  assert.notEqual(keys.passageKey, deriveInvitationKeys(fill(0x12)).passageKey);
});

test("строка Приглашения кодируется и разбирается обратно", () => {
  assert.equal(encodeInvitation(V.invitation), V.invitationString);
  assert.ok(V.invitationString.startsWith("aristotel-priglashenie-v1:"));
  assert.deepEqual(parseInvitation(V.invitationString), V.invitation);
  assert.deepEqual(parseInvitation(`  ${V.invitationString}\n`), V.invitation, "перевод строки файла допускается");
});

test("строка Приглашения: лишнее поле, неверный префикс, плохой base64url, не тот ключ — отказ", () => {
  const withExtra = encodeInvitation({ ...V.invitation, extra: "x" } as unknown as Invitation);
  assert.throws(() => parseInvitation(withExtra), InvitationFormatError);
  assert.throws(() => parseInvitation(V.invitationString.replace("v1:", "v2:")), InvitationFormatError);
  assert.throws(() => parseInvitation("aristotel-priglashenie-v1:***"), InvitationFormatError);
  assert.throws(() => parseInvitation(encodeInvitation({ ...V.invitation, secret: "x" })), InvitationFormatError);
  assert.throws(() => parseInvitation(encodeInvitation({ ...V.invitation, passages: [] })), InvitationFormatError);
});

test("вход Станции: подпись над вызовом и EKM (STATION-10)", () => {
  const challenge = decodeBytes(V.login.challenge, 32)!;
  const ekm = decodeBytes(V.login.ekm, 32)!;
  const message = stationLoginMessage(challenge, ekm);
  assert.equal(hex(message), manual("aristotel/vhod-stancii/v1", challenge, ekm));
  assert.equal(hex(message), V.login.message);
  assert.equal(publicKeyText(ed25519FromSeed(fill(V.stationKeySeedByte))), V.stationKey);
  assert.ok(ed25519Verify(V.stationKey, message, decodeBytes(V.login.signature)!));
  assert.ok(!ed25519Verify(V.stationKey, stationLoginMessage(challenge, fill(0x16)), decodeBytes(V.login.signature)!), "другой EKM");
});

test("подтверждение присутствия: сеанс, метод, путь, хэш тела, время, nonce (STATION-12)", () => {
  const p = V.presence;
  const nonce = decodeBytes(p.nonce, 16)!;
  const message = presenceMessage({ ...p, nonce });
  assert.equal(hex(message), manual("aristotel/prisutstvie/v1", p.sessionId, p.method, p.path, p.bodySha256, p.issuedAt, nonce));
  assert.equal(hex(message), p.message);
  assert.ok(ed25519Verify(V.stationKey, message, decodeBytes(p.signature)!));
  assert.equal(p.bodySha256, createHash("sha256").update(presenceBodyText({ label: "x", role: "participant" })).digest("hex"));
  assert.equal(presenceBodyText(undefined), "");
  const header = encodePresenceHeader({ issuedAt: p.issuedAt, nonce: p.nonce, signature: p.signature });
  assert.deepEqual(parsePresenceHeader(header), { issuedAt: p.issuedAt, nonce: p.nonce, signature: p.signature });
  assert.equal(parsePresenceHeader("не base64url"), undefined);
});

test("подтверждение удаления: Станция и команда (STATION-22)", () => {
  const d = V.deletion;
  const message = deletionMessage(d.stationId, d.commandId);
  assert.equal(hex(message), manual("aristotel/udalenie/v1", d.stationId, d.commandId));
  assert.equal(hex(message), d.message);
  assert.ok(ed25519Verify(V.stationKey, message, decodeBytes(d.signature)!));
});
