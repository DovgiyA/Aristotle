// Разбор и запись IP-адресов своим кодом, без регулярных выражений над вводом: Класс `ip` (DICT-33),
// формат `ip`/`ip-cidr` (§5 приложения), диапазоны Стоп-листа (DICT-41).

export type Ip = { v: 4; bytes: number[] } | { v: 6; words: number[] };

const isDigit = (c: string) => c >= "0" && c <= "9";
const HEX = "0123456789abcdefABCDEF";

/** IPv4: четыре десятичных октета; ведущие нули допустимы и отбрасываются (DICT-33). */
export function parseIpv4(s: string): number[] | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const p of parts) {
    if (p.length === 0 || p.length > 3 || ![...p].every(isDigit)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    bytes.push(n);
  }
  return bytes;
}

export function parseIpv6(s: string): number[] | undefined {
  if (s.includes("%")) return undefined;
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  // IPv4 — только в последних группах адреса: в конце правой части или всего адреса без «::» (T233).
  const parseSide = (side: string, tail: boolean): number[] | undefined => {
    if (side === "") return [];
    const out: number[] = [];
    const groups = side.split(":");
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (tail && i === groups.length - 1 && g.includes(".")) {
        const v4 = parseIpv4(g);
        if (v4 === undefined) return undefined;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (g.length === 0 || g.length > 4 || ![...g].every((c) => HEX.includes(c))) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parseSide(halves[0]!, halves.length === 1);
  if (left === undefined) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const right = parseSide(halves[1]!, true);
  if (right === undefined || left.length + right.length > 7) return undefined;
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export function parseIp(s: string): Ip | undefined {
  if (s.includes(":")) {
    const words = parseIpv6(s);
    return words === undefined ? undefined : { v: 6, words };
  }
  const bytes = parseIpv4(s);
  return bytes === undefined ? undefined : { v: 4, bytes };
}

/** Запись по RFC 5952: строчные, без ведущих нулей, самая длинная серия нулей (≥ 2, при равенстве — первая) — `::`. */
export function formatIp(ip: Ip): string {
  if (ip.v === 4) return ip.bytes.join(".");
  const w = ip.words;
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
    return `::ffff:${w[6]! >> 8}.${w[6]! & 0xff}.${w[7]! >> 8}.${w[7]! & 0xff}`;
  }
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (w[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = w.map((x) => x.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

/** Адрес как 32 или 128 бит — для сравнения с диапазоном. */
export function ipBits(ip: Ip): bigint {
  let n = 0n;
  if (ip.v === 4) for (const b of ip.bytes) n = (n << 8n) | BigInt(b);
  else for (const x of ip.words) n = (n << 16n) | BigInt(x);
  return n;
}

export interface Cidr {
  v: 4 | 6;
  base: bigint;
  prefix: number;
}

export function parseCidr(s: string): Cidr | undefined {
  const slash = s.indexOf("/");
  if (slash < 0) return undefined;
  const ip = parseIp(s.slice(0, slash));
  const p = s.slice(slash + 1);
  if (ip === undefined || p.length === 0 || p.length > 3 || ![...p].every(isDigit)) return undefined;
  const prefix = Number(p);
  const width = ip.v === 4 ? 32 : 128;
  if (prefix > width) return undefined;
  const shift = BigInt(width - prefix);
  return { v: ip.v, base: (ipBits(ip) >> shift) << shift, prefix };
}

export function inCidr(ip: Ip, cidr: Cidr): boolean {
  if (ip.v !== cidr.v) return false;
  const shift = BigInt((ip.v === 4 ? 32 : 128) - cidr.prefix);
  return (ipBits(ip) >> shift) << shift === cidr.base;
}
