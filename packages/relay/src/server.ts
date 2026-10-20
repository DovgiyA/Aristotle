// Ретранслятор — третья роль программы: HTTPS на Fastify с самоподписанным сертификатом Ed25519
// (RELAY-22, RELAY-10), Реестр как есть (RELAY-11), вход Опорной станции (RELAY-08), Проходы
// (STATION-02). Логи — метод и путь без адресов и параметров; адресов он не хранит (RELAY-24;
// research R3, R16 фичи 004).
import Fastify, { type FastifyInstance } from "fastify";
import { Value } from "typebox/value";
import {
  RELAY_ERROR_STATUS,
  RELAY_MAX_BODY,
  RelayLoginRequest,
  decodeBytes,
  type RelayErrorCode,
} from "@aristotel/protocol";
// Только установка и TLS — без БД Банка и API Опорной станции (research R1 фичи 004).
import { readInstall, InstallError } from "@aristotel/core/install";
import { ensureTlsKey, type TlsMaterial } from "@aristotel/core/tls";
import { RelayRegistry } from "./registry.ts";
import { ChallengeStore, TokenStore, login } from "./login.ts";
import { DEFAULT_PASSAGE_TIMERS, PassageHub, type PassageTimers } from "./passage.ts";
import { Counters } from "./counters.ts";

export interface RelayOptions {
  dataDir: string;
  /** Порт и адрес прослушивания вместо install.json (стенд — свободный порт на loopback). */
  port?: number;
  host?: string;
  logStream?: { write: (line: string) => void };
  /** Уровень логов: serve пишет только предупреждения и ошибки (contracts/cli.md). */
  logLevel?: "info" | "warn" | "error";
  timers?: Partial<PassageTimers>;
}

export interface RelayServer {
  app: FastifyInstance;
  port: number;
  registry: RelayRegistry;
  passages: PassageHub;
  tls: TlsMaterial;
  close: () => Promise<void>;
}

/**
 * Ограничение частоты вызовов — в памяти, по адресу соединения; запись живёт 60 с и удаляется
 * проверкой sweep независимо от того, вернётся ли клиент (RELAY-24, research R16).
 */
export class RateLimit {
  readonly #hits = new Map<string, { count: number; since: number }>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  get size(): number {
    return this.#hits.size;
  }

  allow(key: string, limit = 120): boolean {
    const now = this.#clock();
    const item = this.#hits.get(key);
    if (item === undefined || now - item.since > 60_000) {
      this.#hits.set(key, { count: 1, since: now });
      if (this.#hits.size > 10_000) this.sweep();
      return true;
    }
    item.count += 1;
    return item.count <= limit;
  }

  /** Забыть адреса, окно которых кончилось. */
  sweep(): void {
    const now = this.#clock();
    for (const [key, item] of this.#hits) if (now - item.since > 60_000) this.#hits.delete(key);
  }
}

function parseListen(listen: string): { host: string; port: number } {
  const index = listen.lastIndexOf(":");
  return { host: listen.slice(0, index).replace(/^\[|\]$/g, ""), port: Number(listen.slice(index + 1)) };
}

export async function startRelay(options: RelayOptions): Promise<RelayServer> {
  const install = readInstall(options.dataDir);
  if (install.role !== "relay" || install.relay === undefined) throw new InstallError("role_not_available", { role: install.role });
  const tls = ensureTlsKey(options.dataDir);
  const registry = new RelayRegistry(options.dataDir, install.relay.group, tls.tlsSpki);
  const loginChallenges = new ChallengeStore();
  const passageChallenges = new ChallengeStore();
  const tokens = new TokenStore();
  const counters = new Counters(options.dataDir);
  const passages = new PassageHub(tokens, passageChallenges, counters, { ...DEFAULT_PASSAGE_TIMERS, ...options.timers });
  const rate = new RateLimit();
  // Адреса забываются через 60 с и без новых обращений (RELAY-24).
  const sweep = setInterval(() => rate.sweep(), 10_000);
  sweep.unref();
  const spki = decodeBytes(tls.tlsSpki, 32)!;

  const app = Fastify({
    https: tls.serverOptions(),
    // Остановка не ждёт соединений в рукопожатии или на долгом запросе — закрывает все.
    forceCloseConnections: true,
    bodyLimit: 2 * RELAY_MAX_BODY,
    logger:
      options.logStream === undefined
        ? false
        : {
            stream: options.logStream,
            level: options.logLevel ?? "info",
            // Только метод и путь: адрес и порт клиента в логи не попадают (RELAY-24).
            serializers: {
              req: (req) => ({ method: req.method, path: String(req.url).split("?")[0] }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
  });

  const fail = (code: RelayErrorCode, extra: Record<string, unknown> = {}) => ({ status: RELAY_ERROR_STATUS[code], body: { error: code, ...extra } });

  app.setErrorHandler(async (_error, _request, reply) => {
    const { status, body } = fail("bad_request");
    return reply.status(status).send(body);
  });
  app.setNotFoundHandler(async (_request, reply) => reply.status(404).send({ error: "not_found" }));

  app.post("/relay/v1/vhod/vyzov", async (request, reply) => {
    if (!rate.allow(request.socket.remoteAddress ?? "")) return reply.status(429).send({ error: "slow_down" });
    return loginChallenges.issue();
  });

  app.put("/relay/v1/reestr", async (request, reply) => {
    const result = registry.apply(JSON.stringify(request.body));
    if (result.kind === "rejected") {
      const { status, body } = fail("registry_rejected", { reason: result.reason });
      return reply.status(status).send(body);
    }
    return { number: result.number };
  });

  app.post("/relay/v1/vhod", async (request, reply) => {
    if (!Value.Check(RelayLoginRequest, request.body)) {
      const { status, body } = fail("bad_request");
      return reply.status(status).send(body);
    }
    const outcome = login({ registry, challenges: loginChallenges, tokens, tlsSpki: spki, ownGroup: install.relay!.group }, request.body);
    if (outcome.kind === "registry_needed") {
      const { status, body } = fail("registry_needed", { registryNumber: outcome.registryNumber });
      return reply.status(status).send(body);
    }
    if (outcome.kind === "forbidden") {
      counters.add("refusals");
      const { status, body } = fail("forbidden");
      return reply.status(status).send(body);
    }
    counters.add("logins");
    return outcome.body;
  });

  // Вызов Прохода: ответ одинаков, есть ли Группа на Ретрансляторе или нет (contracts/prohod-v1.md).
  app.post<{ Params: { code: string } }>("/relay/v1/prohod/:code/vyzov", async (request, reply) => {
    if (!rate.allow(request.socket.remoteAddress ?? "")) return reply.status(429).send({ error: "slow_down" });
    return passageChallenges.issue();
  });

  app.server.on("upgrade", (req, socket, head) => {
    if (!passages.handleUpgrade(req, socket, head)) socket.destroy();
  });

  const listen = install.relay.listen === "" ? { host: "0.0.0.0", port: 443 } : parseListen(install.relay.listen);
  await app.listen({ host: options.host ?? listen.host, port: options.port ?? listen.port });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : listen.port;
  let closed = false;
  return {
    app,
    port,
    registry,
    passages,
    tls,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      passages.close();
      counters.stop();
      await app.close();
    },
  };
}
