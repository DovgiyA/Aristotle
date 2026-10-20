// «имя-хоста» — только первая метка, ASCII в нижнем регистре (DICT-29).
import { fail, ok, trimSpace, type NormResult } from "./common.ts";

const LABEL = /^[A-Za-z0-9-]{1,63}$/;

export function imyaHosta(input: string): NormResult {
  const first = trimSpace(input).split(".", 1)[0] ?? "";
  return LABEL.test(first) ? ok(first.toLowerCase()) : fail("label");
}
