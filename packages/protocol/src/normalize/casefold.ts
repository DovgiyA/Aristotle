// toNFKC_Casefold по Unicode 17.0: каждый символ — по свойству NFKC_CF, затем NFC (Unicode 3.13, D145).
import { NFKC_CF_TABLE } from "./nfkc-cf-table.ts";

function lookup(cp: number): readonly number[] | undefined {
  let lo = 0;
  let hi = NFKC_CF_TABLE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = NFKC_CF_TABLE[mid]!;
    if (cp < row[0]) hi = mid - 1;
    else if (cp > row[1]) lo = mid + 1;
    else return row[2];
  }
  return undefined;
}

export function nfkcCasefold(input: string): string {
  let out = "";
  for (const ch of input) {
    const mapped = lookup(ch.codePointAt(0)!);
    out += mapped === undefined ? ch : String.fromCodePoint(...mapped);
  }
  return out.normalize("NFC");
}
