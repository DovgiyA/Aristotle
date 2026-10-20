// Клиент интерфейса: подтверждение присутствия — повторный запрос пароля говорит, что прошлый был
// неверным (STATION-12; ручной прогон на Linux Mint 2026-10-18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiFailure, LocalApi } from "../src/api.ts";

test("неверный пароль присутствия — повторный запрос с признаком retry; отказ человека — ошибка", async (t) => {
  const replies = [
    { status: 403, body: { error: "presence_required", message: "нужен пароль" } },
    { status: 403, body: { error: "password_wrong", message: "Неверный пароль." } },
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const next = replies.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  });
  const asks: boolean[] = [];
  const api = new LocalApi(async (retry) => {
    asks.push(retry);
    return asks.length === 1 ? "wrong-password-x" : null;
  });
  await assert.rejects(api.request("POST", "/api/members", { label: "У3" }), (e: unknown) => e instanceof ApiFailure && e.code === "presence_required");
  assert.deepEqual(asks, [false, true]);
});
