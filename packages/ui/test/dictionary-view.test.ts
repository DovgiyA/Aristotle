// T029 — вид «Словарь Сети» и сценарий подписи версии в интерфейсе (research R15 фичи 005;
// Clarifications фичи 005; DICT-16, STATION-12, NET-14): применённая версия видна всем, форма подписи —
// только Старшему; подпись в локальной части с форматом aristotel/slovar/v1, подача с подтверждением.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { message } from "@aristotel/protocol";
import { DictionaryView } from "../src/views/dictionary.ts";
import { signAndApplyDictionary } from "../src/model/dictionary-sign.ts";
import type { SignApi } from "../src/model/registry-sign.ts";

const render = (node: unknown) => renderToString(node as ReactElement);
const current = {
  number: 3,
  bodySha256: "a".repeat(64),
  appliedAt: "2026-10-19T10:00:00.000Z",
  appliedBy: { id: "c1", label: "С1" },
  signedBy: { key: "k", keyFingerprint: "aaaa bbbb" },
};

test("вид: версия, кто подписал, когда применена; форма подписи — только Старшему", () => {
  const senior = render(DictionaryView({ role: "senior", current }));
  assert.match(senior, /aaaa bbbb/);
  assert.match(senior, /С1/);
  assert.match(senior, new RegExp(message("ui.dictionary.sign")));
  for (const role of ["participant", "observer"] as const) assert.doesNotMatch(render(DictionaryView({ role, current })), /data-action|type="file"/, role);
  assert.match(render(DictionaryView({ role: "observer", current: null })), new RegExp(message("ui.dictionary.none")));
});

test("подпись → подача: формат Словаря в /local/coordinator-sign, подтверждение — на /api/dictionary/versions", async () => {
  const calls: [string, string, unknown, Record<string, string> | undefined][] = [];
  const api: SignApi = {
    request: async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
      calls.push([method, path, body, headers]);
      if (path === "/local/coordinator-sign") return { document: { signed: true }, presence: "P" } as T;
      return { number: 4 } as T;
    },
  };
  const n = await signAndApplyDictionary(api, { versionText: '{"format":"aristotel/slovar/v1","body":"{}","signatures":[]}', keyFileText: "KEY", keyPassword: "kp", password: "pw" });
  assert.equal(n, 4);
  assert.deepEqual(calls, [
    ["POST", "/local/coordinator-sign", { password: "pw", keyFile: "KEY", keyPassword: "kp", draft: { format: "aristotel/slovar/v1", body: "{}", signatures: [] }, format: "aristotel/slovar/v1" }, undefined],
    ["POST", "/api/dictionary/versions", { signed: true }, { "aristotel-presence": "P" }],
  ]);
});
