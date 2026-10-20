// `guid` — нижний регистр, 8-4-4-4-12, без фигурных скобок (DICT-32).
import { fail, ok, trimSpace, type NormResult } from "./common.ts";

const GUID = /^\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?$/;

export function guid(input: string): NormResult {
  const s = trimSpace(input);
  const m = GUID.exec(s);
  if (m === null || s.startsWith("{") !== s.endsWith("}")) return fail("guid");
  return ok(m[1]!.toLowerCase());
}
