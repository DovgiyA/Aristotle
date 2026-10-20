// Сборка интерфейса в статические файлы, которые локальная часть Станции отдаёт на 127.0.0.1
// (APP-27, research R15 фичи 004). esbuild — инструмент сборки, в поставку не входит.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const out = join(root, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(out, "app.js"),
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
copyFileSync(join(root, "src", "index.html"), join(out, "index.html"));
copyFileSync(join(root, "src", "app.css"), join(out, "app.css"));
