// Подпись и подача версии Словаря Сети в интерфейсе (research R15 фичи 005; Clarifications фичи 005):
// файл неподписанной версии собран CLI без службы; подпись — локальная часть двумя паролями (Члена
// Группы и файла Ключа Координатора), подача — с подтверждением присутствия, выданным вместе с подписью.
import type { CoordinatorSignResponse } from "@aristotel/protocol/browser";
import type { DictionaryCurrent } from "@aristotel/protocol";
import type { SignApi } from "./registry-sign.ts";

export const SLOVAR_FORMAT_UI = "aristotel/slovar/v1";

export interface DictionarySignInput {
  /** Текст файла неподписанной (или уже подписанной другим ключом) версии. */
  versionText: string;
  keyFileText: string;
  keyPassword: string;
  password: string;
}

/** Подпись → подача; вернуть номер применённой версии. */
export async function signAndApplyDictionary(api: SignApi, input: DictionarySignInput): Promise<number> {
  const draft = JSON.parse(input.versionText) as unknown;
  const signed = await api.request<CoordinatorSignResponse>("POST", "/local/coordinator-sign", {
    password: input.password,
    keyFile: input.keyFileText,
    keyPassword: input.keyPassword,
    draft,
    format: SLOVAR_FORMAT_UI,
  });
  const applied = await api.request<DictionaryCurrent>("POST", "/api/dictionary/versions", signed.document, { "aristotel-presence": signed.presence });
  return applied.number;
}
