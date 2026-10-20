// Конституция V, APP-27: типы JSON API у интерфейса и ядра общие — интерфейс не описывает формы ответов
// сам (`request<{ … }>`), а берёт типы из @aristotel/protocol.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("в packages/ui/src нет ответов API, описанных на месте (request<{ … }>)", () => {
  const found = sources(join(import.meta.dirname, "..", "src")).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => [file, i + 1, line] as const)
      .filter(([, , line]) => /request<\s*\{/.test(line))
      .map(([f, n]) => `${f.split("packages/ui/")[1]}:${n}`),
  );
  assert.deepEqual(found, []);
});

test("в packages/ui/src нет и приведений ответа к форме на месте (as { … })", () => {
  const found = sources(join(import.meta.dirname, "..", "src")).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => [file, i + 1, line] as const)
      .filter(([, , line]) => /\bas \{/.test(line))
      .map(([f, n]) => `${f.split("packages/ui/")[1]}:${n}`),
  );
  assert.deepEqual(found, []);
});
