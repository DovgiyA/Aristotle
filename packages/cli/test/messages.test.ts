// T061 — строки для людей только в locales/ru.json: в исходниках packages/*/src нет русских
// строковых литералов вне комментариев (конституция VIII, APP-09).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Строки кода без комментариев: //…, /* … *\/ и строк-продолжений JSDoc. */
function codeLines(text: string): [number, string][] {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  return withoutBlocks.split("\n").map((line, i): [number, string] => {
    // Комментарий // вне строки: отрезаем всё после первого //, перед которым нет кавычки или двоеточия URL.
    const cut = line.search(/(^|[^:"'`])\/\/(?![^"'`]*["'`])/);
    return [i + 1, cut === -1 ? line : line.slice(0, cut + 1)];
  });
}

test("в packages/*/src нет русских строковых литералов вне комментариев", () => {
  const found: string[] = [];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    for (const file of sources(src)) {
      const code = codeLines(readFileSync(file, "utf8")).map(([, line]) => line).join("\n");
      // Литерал в кавычках или шаблон в обратных кавычках, в том числе многострочный.
      for (const m of code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
        if (/[А-Яа-яЁё]/.test(m[0])) {
          const line = code.slice(0, m.index).split("\n").length;
          found.push(`${relative(ROOT, file)}:${line}: ${m[0].split("\n")[0]?.slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(found, []);
});
