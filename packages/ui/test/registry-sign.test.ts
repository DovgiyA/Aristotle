// Сценарий подписи версии Реестра в интерфейсе (NET-14, FR-018, US4.9): черновик у Опорной станции,
// подпись в локальной части двумя паролями, применение с выданным подтверждением присутствия.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftRequest, signAndApply, type SignApi } from "../src/model/registry-sign.ts";

const SPKI = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

test("черновик → подпись (пароль Члена Группы и пароль файла) → применение с подтверждением", async () => {
  const calls: [string, string, unknown, Record<string, string> | undefined][] = [];
  const api: SignApi = {
    request: async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
      calls.push([method, path, body, headers]);
      if (path === "/api/registry/draft") return { format: "f", body: "{}", signatures: [] } as T;
      if (path === "/local/coordinator-sign") return { document: { signed: true }, presence: "P" } as T;
      return { number: 4 } as T;
    },
  };
  const number = await signAndApply(api, "A", { addRelay: ` https://relay-z.test=${SPKI} `, removeRelay: "https://relay-y.test", keyFileText: "KEY", keyPassword: "kp", password: "pw" });
  assert.equal(number, 4);
  assert.deepEqual(calls, [
    ["POST", "/api/registry/draft", { code: "A", addRelays: [{ url: "https://relay-z.test", tlsSpki: SPKI }], removeRelays: ["https://relay-y.test"] }, undefined],
    ["POST", "/local/coordinator-sign", { password: "pw", keyFile: "KEY", keyPassword: "kp", draft: { format: "f", body: "{}", signatures: [] } }, undefined],
    ["POST", "/api/registry/versions", { signed: true }, { "aristotel-presence": "P" }],
  ]);
});

test("черновик без изменений Ретрансляторов; неверная запись «адрес=отпечаток» — отказ до запросов", () => {
  assert.deepEqual(draftRequest("A", { addRelay: "", removeRelay: "" }), { code: "A" });
  assert.throws(() => draftRequest("A", { addRelay: "https://relay-z.test", removeRelay: "" }), /адрес=отпечаток/);
});
