// Внутренний TLS на Опорной станции: сокет склейки от Ретранслятора оборачивается в TLS 1.3 с её
// TLS-ключом и отдаётся HTTP-серверу API Станций, который портов не слушает (STATION-02, STATION-03,
// RELAY-03; research R8 фичи 004). Ретранслятор содержимого не видит.
import { TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import type { App } from "../api/app.ts";
import type { TlsMaterial } from "../tls/tls-key.ts";

/** Обработчик сокета склейки: TLS-сервер поверх него и соединение в API Станций. */
export function innerTlsHandler(stationApp: App, tls: TlsMaterial): (socket: Duplex) => void {
  const secureContext = tls.secureContext();
  return (socket) => {
    socket.on("error", () => socket.destroy());
    const tlsSocket = new TLSSocket(socket, { isServer: true, secureContext });
    tlsSocket.on("error", () => tlsSocket.destroy());
    stationApp.server.emit("connection", tlsSocket);
  };
}
