// T050 фичи 004 — сценарий 9, шаг 9.11: версия API Станции несовместима с Опорной станцией — Станция не
// подключается и предлагает обновиться (APP-23). Стенд подменяет ответ GET /api/version API Станций.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startNetwork, startStation, waitFor } from "../../support/network.ts";

test("9.11: несовместимая версия API — Станция не входит, updateRequired", async (t) => {
  const net = await startNetwork(t, {
    relays: 1,
    extend: (_app, _db, stationApp) => {
      stationApp.addHook("onRequest", async (request, reply) => {
        if (request.url === "/api/version") return reply.send({ apiVersions: [2], role: "base-station", programVersion: "9.9.9" });
        return undefined;
      });
    },
  });
  await waitFor(() => net.relays[0]!.server!.passages.hasControl("A"));
  // Приём тоже проверяет версию API — Станцию нельзя принять.
  await assert.rejects(startStation(t, net), /update_required/);
});
