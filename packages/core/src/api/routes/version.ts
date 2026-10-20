// GET /api/version — без заголовков, чтобы сторона узнала поддержанные версии (APP-23; research R10).
import type { FastifyInstance } from "fastify";
import { API_VERSIONS, PROGRAM_VERSION, VersionInfo } from "@aristotel/protocol";
import type { Install } from "../../install/install.ts";

export function versionRoutes(app: FastifyInstance, install: Install): void {
  app.get(
    "/api/version",
    { schema: { response: { 200: VersionInfo } }, config: { public: true } },
    async () => ({ apiVersions: [...API_VERSIONS], role: install.role, programVersion: PROGRAM_VERSION }),
  );
}
