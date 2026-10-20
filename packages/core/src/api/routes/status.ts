// GET /api/status — состояние Опорной станции для CLI на ней самой (APP-34; contracts/http-api.md
// фичи 004): отпечатки Ключа Группы и TLS, номер Реестра, развилка, Проходы, число Станций.
import type { FastifyInstance } from "fastify";
import { StatusResponse, type RelayLink } from "@aristotel/protocol";
import type { Db } from "../../db/open.ts";
import type { GroupKeyHandle } from "../../network/group-key.ts";
import { registryState } from "../../network/registry.ts";

export interface StatusContext {
  db: Db;
  groupKey: GroupKeyHandle;
  tlsSpki: () => string;
  relays: () => RelayLink[];
}

export function statusRoutes(app: FastifyInstance, context: StatusContext): void {
  app.get(
    "/api/status",
    { schema: { response: { 200: StatusResponse } }, config: { right: "registry.read", maintenance: true, onlyMaintenance: true } },
    async () => {
      const info = context.groupKey.info();
      const registry = registryState(context.db);
      const active = context.db.prepare("SELECT count(*) AS n FROM station WHERE state = 'active'").get();
      return {
        groupKeyFingerprint: info.keyFingerprint,
        groupKeyState: info.state,
        tlsSpki: context.tlsSpki(),
        registryNumber: registry.current?.number ?? null,
        halted: registry.halted,
        relays: context.relays(),
        activeStations: Number(active?.["n"] ?? 0),
      };
    },
  );
}
