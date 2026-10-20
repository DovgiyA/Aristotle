// «hex» — нижний регистр, без 0x и разделителей; длину проверяет формат типа (DICT-31).
import { fail, ok, removeSpace, type NormResult } from "./common.ts";

export function hex(input: string): NormResult {
  const value = removeSpace(input).replace(/^0x/i, "").replace(/[:-]/g, "").toLowerCase();
  return /^[0-9a-f]+$/.test(value) ? ok(value) : fail("hex");
}
