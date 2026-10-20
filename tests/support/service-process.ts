// Процесс службы для тестов: настоящая служба плюс служебные маршруты /api/test/* стенда; второй
// аргумент — порт, на котором стенд слушает API Станций на loopback без Прохода (research R19 фичи 004).
import { startServer, stopOnSignals } from "@aristotel/core";
import type { Role } from "@aristotel/protocol";
import { addMember, registerTestNote } from "./harness.ts";

const dataDir = process.argv[2];
const stationPort = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
if (dataDir === undefined) throw new Error("не задан каталог данных");

registerTestNote();
const server = await startServer({
  dataDir,
  extend: (app, db, stationApp) => {
    // Заведение Члена Группы прямо в БД — только стенд, чтобы тесты не зависели от состава через API.
    for (const target of [app, stationApp]) {
      target.post("/api/test/members", { config: { right: "member.read", maintenance: true } }, async (request) => {
        const body = request.body as { label: string; role?: Role };
        return { id: addMember(db, String(body.label), body.role) };
      });
      target.get("/api/test/members", { config: { right: "member.read", maintenance: true } }, async () =>
        db.prepare("SELECT id, label, role, state, createdAt FROM member ORDER BY createdAt, id").all(),
      );
    }
  },
});
if (stationPort !== undefined) await server.stationApp.listen({ host: "127.0.0.1", port: stationPort });
stopOnSignals(server);
process.stdout.write(`listening ${server.port}\n`);
