// aristotel serve — программа в роли установки на переднем плане: служба Опорной станции без
// интерфейса на машине (APP-02) или Ретранслятор (RELAY-22); локальная часть Станции — US3 фичи 004.
// Регистрация в менеджере служб ОС — APP-20, фича 018.
import { readInstall, startServer, stopOnSignals } from "@aristotel/core";
import { message } from "@aristotel/protocol";
import { startRelay } from "@aristotel/relay";
import { KeyFileError } from "@aristotel/core";
import { startLocalServer } from "@aristotel/station";
import { readPassword } from "../password.ts";
import { EXIT, printError } from "../output.ts";

/**
 * Локальная часть Станции: интерфейс и API на 127.0.0.1; Ключ станции открывает пароль — с терминала,
 * если он есть, иначе в интерфейсе или командой station unlock (STATION-09; research R13 фичи 004).
 */
async function serveStation(dataDir: string): Promise<number | undefined> {
  let server;
  try {
    server = await startLocalServer({
      dataDir,
      // Ключ станции удалён по команде Опорной станции — сказать и выйти (STATION-22).
      onDeleted: () => {
        process.stdout.write(message("station_deleted") + "\n");
        process.exit(0);
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "EADDRINUSE") {
      printError(message("cli_port_in_use", { port: readInstall(dataDir).port }));
      return EXIT.refused;
    }
    throw error;
  }
  const stop = (): void => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(message("cli_station_listening", { port: server.port }) + "\n");
  if (process.stdin.isTTY === true) {
    try {
      await server.part.unlock(await readPassword({ file: undefined, confirm: false, member: true }));
    } catch (error) {
      if (error instanceof KeyFileError) printError(error.message);
    }
  }
  return undefined;
}

/** Ретранслятор работает до SIGTERM или SIGINT; в stderr — только ошибки без адресов (RELAY-24). */
async function serveRelay(dataDir: string): Promise<undefined> {
  const relay = await startRelay({ dataDir, logStream: process.stderr, logLevel: "warn" });
  const stop = (): void => {
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(message("cli_relay_listening", { listen: readInstall(dataDir).relay?.listen ?? "" }) + "\n");
  return undefined;
}

export async function serve(args: { dataDir: string }): Promise<number | undefined> {
  const install = readInstall(args.dataDir);
  if (install.role === "relay") return await serveRelay(args.dataDir);
  if (install.role === "station") return await serveStation(args.dataDir);
  const server = await startServer({ dataDir: args.dataDir, logStream: process.stderr });
  stopOnSignals(server);
  // Адреса — те, что служба действительно слушает: localhost бывает и только 127.0.0.1 (Linux Mint).
  const addresses = server.app.addresses().map((a) => (a.family === "IPv6" ? `[${a.address}]:${a.port}` : `${a.address}:${a.port}`));
  process.stdout.write(message("cli_service_listening", { addresses: addresses.join(", ") }) + "\n");
  // Процесс живёт до SIGTERM/SIGINT; код выхода задаёт stopOnSignals.
  return undefined;
}

export { EXIT };
