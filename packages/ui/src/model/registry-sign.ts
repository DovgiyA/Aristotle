// Подпись версии Реестра в интерфейсе (NET-14, FR-018, US4.9): черновик собирает Опорная станция,
// подпись — локальная часть двумя паролями (Члена Группы и файла Ключа Координатора), применение —
// с подтверждением присутствия, выданным вместе с подписью (contracts/lokalnaya-chast.md).
import type { CoordinatorSignResponse } from "@aristotel/protocol/browser";
import type { RegistryCurrent, SignedDocument } from "@aristotel/protocol";
import { t } from "../strings.ts";

export interface SignApi {
  request: <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>;
}

export interface DraftInput {
  /** «адрес=отпечаток» добавляемого Ретранслятора или пусто. */
  addRelay: string;
  /** Адрес убираемого Ретранслятора или пусто. */
  removeRelay: string;
}

export interface SignInput extends DraftInput {
  keyFileText: string;
  keyPassword: string;
  password: string;
}

/** Тело POST /api/registry/draft (contracts/http-api.md фичи 003). */
export function draftRequest(code: string, input: DraftInput): Record<string, unknown> {
  const body: Record<string, unknown> = { code };
  const add = input.addRelay.trim();
  if (add !== "") {
    const at = add.indexOf("=");
    if (at <= 0 || at === add.length - 1) throw new Error(t("ui.registry.add_relay_format"));
    body["addRelays"] = [{ url: add.slice(0, at).trim(), tlsSpki: add.slice(at + 1).trim() }];
  }
  const remove = input.removeRelay.trim();
  if (remove !== "") body["removeRelays"] = [remove];
  return body;
}

/** Черновик → подпись → применение; вернуть номер применённой версии. */
export async function signAndApply(api: SignApi, code: string, input: SignInput): Promise<number> {
  const draft = await api.request<SignedDocument>("POST", "/api/registry/draft", draftRequest(code, input));
  const signed = await api.request<CoordinatorSignResponse>("POST", "/local/coordinator-sign", {
    password: input.password,
    keyFile: input.keyFileText,
    keyPassword: input.keyPassword,
    draft,
  });
  const applied = await api.request<RegistryCurrent>("POST", "/api/registry/versions", signed.document, { "aristotel-presence": signed.presence });
  return applied.number;
}
