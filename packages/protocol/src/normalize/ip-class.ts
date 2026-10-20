// `ip` — IPv4 без ведущих нулей (октет читается десятично), IPv6 по RFC 5952 (DICT-33).
import { fail, ok, trimSpace, type NormResult } from "./common.ts";
import { formatIp, parseIp } from "./ip.ts";

export function ipClass(input: string): NormResult {
  const ip = parseIp(trimSpace(input));
  return ip === undefined ? fail("ip") : ok(formatIp(ip));
}
