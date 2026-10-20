// TLS-ключ и сертификат Опорной станции и Ретранслятора: файлы tls-key.pem (только учётной записи
// программы) и tls-cert.pem в каталоге данных, вне БД — в резервную копию ключ не попадает (BANK-52);
// перевыпуск сертификата на том же ключе (RELAY-16, STATION-40); клиент сверяет SHA-256 SPKI и рвёт
// соединение до отправки данных, если отпечаток чужой (RELAY-10, STATION-03; research R2 фичи 004).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { encodeKey } from "@aristotel/protocol";
import { createAtomically } from "../install/install.ts";
import { selfSignedCertificate } from "./certificate.ts";

export const TLS_KEY_FILE = "tls-key.pem";
export const TLS_CERT_FILE = "tls-cert.pem";

export interface TlsMaterial {
  /** SHA-256 от SPKI в DER, base64 без «=» (RELAY-16). */
  tlsSpki: string;
  certPem: string;
  secureContext: () => tls.SecureContext;
  /** Опции сервера TLS 1.3 — для Fastify https и tls.TLSSocket. */
  serverOptions: () => { key: string; cert: string; minVersion: "TLSv1.3" };
}

/** Отпечаток SPKI ключа — открытого или секретного (тот же, что у сертификата на нём). */
export function spkiOfKey(key: KeyObject): string {
  const spki = (key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" });
  return encodeKey(createHash("sha256").update(spki).digest());
}

function material(dir: string): TlsMaterial {
  const keyPem = readFileSync(join(dir, TLS_KEY_FILE), "utf8");
  const certPem = readFileSync(join(dir, TLS_CERT_FILE), "utf8");
  const key = createPrivateKey(keyPem);
  const tlsSpki = spkiOfKey(key);
  const options = { key: keyPem, cert: certPem, minVersion: "TLSv1.3" as const };
  return {
    tlsSpki,
    certPem,
    secureContext: () => tls.createSecureContext(options),
    serverOptions: () => options,
  };
}

function writeCertificate(dir: string, key: KeyObject): void {
  const path = join(dir, TLS_CERT_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, selfSignedCertificate(key), { mode: 0o644 });
  renameSync(temp, path);
}

/** Создать TLS-ключ и сертификат при первом запуске; дальше — прочитать те же. */
export function ensureTlsKey(dir: string): TlsMaterial {
  const keyPath = join(dir, TLS_KEY_FILE);
  if (!existsSync(keyPath)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    // Параллельный запуск: файл ключа получает ровно один процесс, второй читает его.
    createAtomically(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), true);
  }
  if (!existsSync(join(dir, TLS_CERT_FILE))) writeCertificate(dir, createPrivateKey(readFileSync(keyPath, "utf8")));
  return material(dir);
}

/** Новый сертификат на том же ключе — отпечаток не меняется (RELAY-16, STATION-40). */
export function renewTlsCertificate(dir: string): TlsMaterial {
  writeCertificate(dir, createPrivateKey(readFileSync(join(dir, TLS_KEY_FILE), "utf8")));
  return material(dir);
}

/** Отпечаток TLS установки без чтения секретного ключа другими модулями. */
export function tlsSpkiOf(dir: string): string {
  return material(dir).tlsSpki;
}

export class TlsMismatchError extends Error {
  readonly expected: string;
  readonly seen: string;
  constructor(expected: string, seen: string) {
    super("tls_mismatch");
    this.expected = expected;
    this.seen = seen;
  }
}

export type PinnedTarget = { socket: Duplex } | { host: string; port: number };

/**
 * TLS 1.3 к серверу с закреплённым отпечатком: проверка — сразу после рукопожатия, до записи данных;
 * сертификат — носитель ключа, его даты и цепочка не проверяются (research R2).
 */
export function pinnedTlsConnect(target: PinnedTarget, expectedSpki: string, timeoutMs = 10_000): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const options: tls.ConnectionOptions = { rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" };
    if ("socket" in target) options.socket = target.socket;
    else {
      options.host = target.host;
      options.port = target.port;
      options.servername = /^[\d.:]+$/.test(target.host) ? "" : target.host;
    }
    const socket = tls.connect(options);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("tls_timeout"));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerX509Certificate();
      const seen = cert === undefined ? "" : spkiOfKey(cert.publicKey);
      if (seen !== expectedSpki) {
        socket.destroy();
        reject(new TlsMismatchError(expectedSpki, seen));
        return;
      }
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
