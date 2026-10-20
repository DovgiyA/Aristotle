// Классы нормализации версии 1 — код программы; их назначение типам — данные Словаря Сети (DICT-26).
// Класс неизменяем: другой алгоритм — новое имя («имя-хоста/2»). Векторы — contracts/normalizaciya-v1.md.
import { message } from "../messages.ts";
import names from "../slovar-names.json" with { type: "json" };
import type { NormEnv, NormResult } from "./common.ts";
import { domen } from "./domen.ts";
import { guid } from "./guid.ts";
import { hex } from "./hex.ts";
import { imyaHosta } from "./imya-hosta.ts";
import { ipClass } from "./ip-class.ts";
import { seriynyi } from "./seriynyi.ts";
import { sshKlyuch } from "./ssh-klyuch.ts";
import { stroka } from "./stroka.ts";
import { strokaBezRegistra } from "./stroka-bez-registra.ts";
import { tseloe } from "./tseloe.ts";

export type { NormEnv, NormResult } from "./common.ts";
export { UNICODE_VERSION } from "./nfkc-cf-table.ts";
export { parseIp, formatIp, parseCidr, inCidr, type Ip, type Cidr } from "./ip.ts";
export { sha256 } from "./sha256.ts";
export { trimSpace } from "./common.ts";

/** Классы по коду программы; имя Класса в Словаре — slovar-names.json (данные протокола). */
const BY_KEY: Readonly<Record<keyof typeof names.normClasses, (input: string, env: NormEnv) => NormResult>> = {
  stroka,
  strokaBezRegistra,
  imyaHosta,
  domen,
  hex,
  guid,
  ip: ipClass,
  sshKlyuch,
  seriynyi,
  tseloe,
};

const CLASSES: ReadonlyMap<string, (input: string, env: NormEnv) => NormResult> = new Map(
  (Object.keys(BY_KEY) as (keyof typeof BY_KEY)[]).map((key) => [names.normClasses[key], BY_KEY[key]]),
);

/** Классы нормализации, которые знает эта версия программы (DICT-01: новый класс — новая версия программы). */
export const NORM_CLASSES: readonly string[] = [...CLASSES.keys()];

export function isNormClass(name: string): boolean {
  return CLASSES.has(name);
}

/** Нормализованная форма значения по Классу; неизвестный Класс — ошибка программы, а не метка. */
export function normalize(className: string, input: string, env: NormEnv): NormResult {
  const fn = CLASSES.get(className);
  if (fn === undefined) throw new Error(message("norm_class_unknown", { name: className }));
  return fn(input, env);
}
