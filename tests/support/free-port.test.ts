// Порт стенда — вне эфемерных диапазонов (Linux 32768–60999, macOS и Windows 49152–65535): иначе
// исходящее соединение параллельного теста занимает его до запуска службы — EADDRINUSE (Linux Mint,
// 2026-10-18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { freePort } from "./harness.ts";

test("freePort: свободный порт ниже эфемерных диапазонов, разные при повторах", async () => {
  const ports = await Promise.all(Array.from({ length: 20 }, () => freePort()));
  for (const port of ports) assert.ok(port >= 20_000 && port < 32_000, String(port));
  assert.ok(new Set(ports).size > 1);
});
