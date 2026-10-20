// «строка-без-регистра» — NFKC_Casefold, пробелы по краям обрезаны, внутренние схлопнуты (DICT-28).
import { nfkcCasefold } from "./casefold.ts";
import { collapseSpace, fail, ok, trimSpace, type NormResult } from "./common.ts";

export function strokaBezRegistra(input: string): NormResult {
  const value = collapseSpace(trimSpace(nfkcCasefold(input)));
  return value === "" ? fail("empty") : ok(value);
}
