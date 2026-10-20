// Запуск службы Опорной станции: API сопровождения только на loopback, API Станций без портов —
// его соединения приходят из Проходов; TLS-ключ вне БД; штатная остановка со сбросом WAL
// (APP-02, APP-34, BANK-01, BANK-52, STATION-01, RELAY-03; research R6 фичи 001, R2, R9 фичи 004).
import { reconcileMaterials } from "./materials/upload.ts";
import { join } from "node:path";
import { openDatabase, closeDatabase, type Db } from "./db/open.ts";
import { migrate } from "./db/migrations.ts";
import { checkBankMatchesInstall, readAccessToken, readInstall, InstallError, type Install } from "./install/install.ts";
import { buildMaintenanceApp, buildStationApp, type App, type AppOptions } from "./api/app.ts";
import { ensureGroupKey } from "./network/group-key.ts";
import { ensureTlsKey, type TlsMaterial } from "./tls/tls-key.ts";
import { PresenceVerifier } from "./stations/presence.ts";
import { SessionChallenges, StationConnections, expireSessions } from "./stations/sessions.ts";
import { expireDeleteOnly } from "./stations/stations.ts";
import { RelayClient, type RelayClientTimers } from "./passage/relay-client.ts";
import { innerTlsHandler } from "./passage/inner-tls.ts";

export interface Server {
  /** API сопровождения на loopback (APP-34). */
  app: App;
  /** API Станций — без портов; соединения подключают Проходы (US1–US3 фичи 004). */
  stationApp: App;
  tls: TlsMaterial;
  /** Клиент Ретрансляторов: вход, управляющие соединения, склейка (US1 фичи 004). */
  relays: RelayClient;
  db: Db;
  install: Install;
  port: number;
  close: () => Promise<void>;
}

export interface ServerOptions {
  dataDir: string;
  logStream?: AppOptions["logStream"];
  /** Порт вместо install.json: init поднимает службу временно на свободном порту (0). */
  port?: number;
  /** Долгий запрос событий Станции (стенд — короче). */
  eventsWaitMs?: number;
  /** Таймеры клиента Ретрансляторов (стенд — ускоренные). */
  relayTimers?: Partial<RelayClientTimers>;
  /** Дополнительные маршруты (тестовый стенд): API сопровождения и API Станций. */
  extend?: (app: App, db: Db, stationApp: App) => void;
}

/** Банк — файл bank.sqlite в каталоге данных установки в роли base-station (BANK-01, BANK-04). */
export function bankPath(dataDir: string): string {
  return join(dataDir, "bank.sqlite");
}

export function openBank(dataDir: string, install: Install): Db {
  const db = openDatabase(bankPath(dataDir));
  try {
    migrate(db, { role: install.role, installId: install.installId, createdAt: install.createdAt });
    checkBankMatchesInstall(db, install);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export async function startServer(options: ServerOptions): Promise<Server> {
  const install = readInstall(options.dataDir);
  if (install.role !== "base-station") throw new InstallError("role_not_available", { role: install.role });
  const db = openBank(options.dataDir, install);
  // Ключ Группы — до приёма запросов: создать при установке или обновлении, проверить файл (research R2).
  let groupKey;
  try {
    groupKey = await ensureGroupKey(options.dataDir, db);
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
  const tls = ensureTlsKey(options.dataDir);
  const relays = new RelayClient(options.relayTimers === undefined ? { db, groupKey } : { db, groupKey, timers: options.relayTimers });
  const appOptions: AppOptions = {
    db,
    install,
    dataDir: options.dataDir,
    token: readAccessToken(options.dataDir),
    groupKey,
    presence: new PresenceVerifier(),
    tlsSpki: () => tls.tlsSpki,
    relays: () => relays.states(),
    sessionChallenges: new SessionChallenges(),
    connections: new StationConnections(),
  };
  if (options.eventsWaitMs !== undefined) appOptions.eventsWaitMs = options.eventsWaitMs;
  if (options.logStream !== undefined) appOptions.logStream = options.logStream;
  const app = buildMaintenanceApp(appOptions);
  const stationApp = buildStationApp(appOptions);
  options.extend?.(app, db, stationApp);
  // Материалы после сбоя: доставка, доведённая до дерева, и незавершённая уборка удалённых (research R6,
  // R10 фичи 006) — до приёма соединений Станций.
  await reconcileMaterials(db, options.dataDir);
  // Соединения Станций приходят из Проходов внутри TLS (research R8 фичи 004).
  await stationApp.ready();
  relays.setSpliceHandler(innerTlsHandler(stationApp, tls));
  try {
    // host "localhost": Fastify слушает 127.0.0.1 и ::1, внешних адресов нет.
    await app.listen({ host: "localhost", port: options.port ?? install.port });
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : install.port;
  relays.start();
  // Сроки сеансов: при запуске и раз в минуту (STATION-34, research R12 фичи 004).
  expireSessions(db);
  const sweep = setInterval(() => {
    try {
      expireSessions(db);
    } catch {
      // БД недоступна — следующая проверка через минуту.
    }
  }, 60_000);
  sweep.unref();
  // Сроки «только удаление»: при запуске и раз в час — ключи уходят из перечня Прохода (research R11).
  let deleteOnlyChecked = new Date(0);
  const checkDeleteOnly = (): void => {
    const now = new Date();
    try {
      expireDeleteOnly(db, deleteOnlyChecked, now);
      deleteOnlyChecked = now;
    } catch {
      // БД недоступна — следующая проверка через час.
    }
  };
  checkDeleteOnly();
  const hourly = setInterval(checkDeleteOnly, 60 * 60_000);
  hourly.unref();
  let closed = false;
  return {
    app,
    stationApp,
    tls,
    relays,
    db,
    install,
    port,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      clearInterval(hourly);
      relays.stop();
      await app.close();
      await stationApp.close();
      closeDatabase(db);
    },
  };
}

/** Работать до SIGTERM или SIGINT, затем штатно остановиться. */
export function stopOnSignals(server: Server): void {
  const stop = (): void => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
