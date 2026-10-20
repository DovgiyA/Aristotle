// «серийный» — NFKC, без пробелов, ASCII в верхнем регистре (DICT-35).
import { fail, ok, removeSpace, type NormResult } from "./common.ts";

export function seriynyi(input: string): NormResult {
  const value = removeSpace(input.normalize("NFKC")).replace(/[a-z]+/g, (m) => m.toUpperCase());
  return value === "" ? fail("empty") : ok(value);
}
