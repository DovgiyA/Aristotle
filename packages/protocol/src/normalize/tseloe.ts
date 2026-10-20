// «целое» — десятичное целое без знака и ведущих нулей; разделители разрядов — только пробел U+0020,
// U+00A0, U+202F и «_»; с запятой, точкой или апострофом внутри числа или со знаком — не нормализуется (DICT-36, DICT-62).
import { fail, ok, trimSpace, type NormResult } from "./common.ts";

export function tseloe(input: string): NormResult {
  const digits = trimSpace(input).replace(/[   _]/g, "");
  if (!/^[0-9]+$/.test(digits)) return fail("integer");
  return ok(digits.replace(/^0+(?=[0-9])/, ""));
}
