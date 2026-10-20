// «домен» — UTS #46 → A-метки, нижний регистр, без точки в конце (DICT-30).
import { fail, ok, trimSpace, type NormEnv, type NormResult } from "./common.ts";

/**
 * Ввод — имя домена, а не адрес URL и не числовой адрес: без пути, запроса, фрагмента, `%`-последовательностей,
 * `\\`, `@`, `:`, скобок и пробелов внутри; последняя метка — не число (`127.1`, `0x7f.1`) (DICT-30; T242).
 * Разбор хоста URL иначе отрезал бы лишнее и переписал числовой адрес молча.
 */
export function isDomainShape(input: string): boolean {
  if (/[/?#%\\@:\s[\]]/.test(input)) return false;
  const labels = input.replace(/\.$/, "").split(".");
  return !/^(0x[0-9a-f]*|\d+)$/i.test(labels[labels.length - 1] ?? "");
}

/** Последняя метка после отображения UTS #46 — число: это адрес (`127。1` → `127.0.0.1`), а не домен (T256). */
export function isNumericHost(ascii: string): boolean {
  const labels = ascii.replace(/\.$/, "").split(".");
  return /^(0x[0-9a-f]*|\d+)$/i.test(labels[labels.length - 1] ?? "");
}

export function domen(input: string, env: NormEnv): NormResult {
  const trimmed = trimSpace(input);
  if (!isDomainShape(trimmed)) return fail("idna");
  const ascii = env.toAscii(trimmed).toLowerCase().replace(/\.$/, "");
  if (isNumericHost(ascii)) return fail("idna");
  // Снимается одна точка в конце; вторая — уже пустая метка (T234).
  return ascii === "" || ascii.startsWith(".") || ascii.endsWith(".") || ascii.includes("..") ? fail("idna") : ok(ascii);
}
