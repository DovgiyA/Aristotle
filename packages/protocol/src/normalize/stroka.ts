// «строка» — NFC, пробелы по краям обрезаны (DICT-27).
import { fail, ok, trimSpace, type NormResult } from "./common.ts";

export function stroka(input: string): NormResult {
  const value = trimSpace(input.normalize("NFC"));
  return value === "" ? fail("empty") : ok(value);
}
