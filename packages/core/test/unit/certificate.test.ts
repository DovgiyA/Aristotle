// T003 — сертификат и TLS-ключ: самоподписанный X.509 на Ed25519, TLS 1.3 поверх произвольного потока,
// сверка SPKI, файлы вне БД с правами владельца, перевыпуск на том же ключе (research R2; RELAY-16,
// STATION-40, BANK-52).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import tls from "node:tls";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { spkiFingerprint } from "@aristotel/protocol";
import { selfSignedCertificate } from "../../src/tls/certificate.ts";
import { ensureTlsKey, pinnedTlsConnect, renewTlsCertificate, tlsSpkiOf, TlsMismatchError } from "../../src/tls/tls-key.ts";

function pair(): [Duplex, Duplex] {
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const make = (out: PassThrough) => new Duplex({ read() {}, write(chunk, enc, cb) { out.write(chunk, enc, cb); }, final(cb) { out.end(); cb(); } });
  const a = make(a2b);
  const b = make(b2a);
  b2a.on("data", (d) => a.push(d));
  a2b.on("data", (d) => b.push(d));
  return [a, b];
}

function dir(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(join(tmpdir(), "aristotel-tls-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test("сертификат: разбор, CN=aristotel, самоподпись, Ed25519, 10 лет", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = selfSignedCertificate(privateKey, new Date("2026-10-18T00:00:00Z"));
  const cert = new X509Certificate(pem);
  assert.equal(cert.subject, "CN=aristotel");
  assert.equal(cert.issuer, "CN=aristotel");
  assert.ok(cert.verify(publicKey));
  assert.equal(cert.publicKey.asymmetricKeyType, "ed25519");
  assert.equal(new Date(cert.validTo).getUTCFullYear(), 2036);
  const other = new X509Certificate(selfSignedCertificate(privateKey, new Date("2026-10-18T00:00:00Z")));
  assert.notEqual(other.serialNumber, cert.serialNumber, "серийный номер случайный");
});

test("ensureTlsKey: файлы создаются один раз, ключ — только владельцу; повтор — те же", async (t) => {
  const d = dir(t);
  const first = ensureTlsKey(d);
  const keyPem = readFileSync(join(d, "tls-key.pem"), "utf8");
  if (process.platform !== "win32") assert.equal(statSync(join(d, "tls-key.pem")).mode & 0o777, 0o600);
  const again = ensureTlsKey(d);
  assert.equal(readFileSync(join(d, "tls-key.pem"), "utf8"), keyPem);
  assert.equal(again.tlsSpki, first.tlsSpki);
  assert.equal(tlsSpkiOf(d), first.tlsSpki);
  assert.equal(spkiFingerprint(readFileSync(join(d, "tls-cert.pem"), "utf8")), first.tlsSpki);
});

test("перевыпуск: серийный номер новый, отпечаток прежний (RELAY-16, STATION-40)", async (t) => {
  const d = dir(t);
  const first = ensureTlsKey(d);
  const before = new X509Certificate(readFileSync(join(d, "tls-cert.pem"))).serialNumber;
  const renewed = renewTlsCertificate(d);
  assert.notEqual(new X509Certificate(readFileSync(join(d, "tls-cert.pem"))).serialNumber, before);
  assert.equal(renewed.tlsSpki, first.tlsSpki);
});

test("TLS 1.3 поверх пары потоков; сверка SPKI на клиенте; чужой отпечаток — разрыв до записи", async (t) => {
  const d = dir(t);
  const material = ensureTlsKey(d);
  const [a, b] = pair();
  const server = new tls.TLSSocket(a, { isServer: true, secureContext: material.secureContext() });
  server.on("data", (chunk: Buffer) => server.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  server.on("error", () => {});
  const client = await pinnedTlsConnect({ socket: b }, material.tlsSpki);
  assert.equal(client.getProtocol(), "TLSv1.3");
  const reply = new Promise<string>((resolve) => client.once("data", (chunk) => resolve(String(chunk))));
  client.write("x");
  assert.equal(await reply, "echo:x");
  client.destroy();

  const [c, e] = pair();
  const server2 = new tls.TLSSocket(c, { isServer: true, secureContext: material.secureContext() });
  let received = 0;
  server2.on("data", () => received++);
  server2.on("error", () => {});
  await assert.rejects(pinnedTlsConnect({ socket: e }, "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"), (error: unknown) => {
    assert.ok(error instanceof TlsMismatchError);
    assert.equal(error.seen, material.tlsSpki);
    return true;
  });
  assert.equal(received, 0);
});

test("серийный номер — минимальный DER INTEGER: 2000 сертификатов подряд принимает OpenSSL", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  for (let i = 0; i < 2000; i++) {
    const cert = selfSignedCertificate(privateKey);
    // Первый байт серийного номера 0x00 перед байтом < 0x80 — «illegal padding» в OpenSSL.
    assert.doesNotThrow(() => tls.createSecureContext({ cert, key }), `сертификат ${i}`);
  }
});
