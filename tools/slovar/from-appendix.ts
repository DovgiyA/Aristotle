// Исходник Словаря Сети версии 1 из приложения «Словарь Сети v1» (research R5 фичи 005; NET-16, DICT-02).
// Разбирает таблицы §1 … §9 markdown и пишет dictionary/source/: types.json, enums.json, classes.json,
// merges.json, stop-lists/<код>.json. Перечни по внешним стандартам (timezone, country, keyboard) —
// из файлов первоисточников закреплённых выпусков. Вывод детерминирован: контрактный тест
// tests/contract/dictionary-source.test.ts сверяет его с каталогом в репозитории.
//
// Запуск: node tools/slovar/from-appendix.ts <slovar-seti-v1.md> <каталог вывода> [<каталог первоисточников>]
// В каталоге первоисточников: tz/zone1970.tab, tz/zone.tab, tz/backward, tz/iso3166.tab, tz/version
// (tzdata) и base.xml (xkeyboard-config, rules/base.xml). Без него внешние перечни берутся из уже
// собранного enums.json каталога вывода.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DictionarySource,
  SourceEnum,
  SourceField,
  SourceIndicatorType,
  SourceLinkType,
  SourceObjectType,
  SourceStopList,
  SourceTemplate,
  ExpectedStopList,
} from "../../packages/protocol/src/slovar-source.ts";

export const TZDATA_VERSION = "2026e";
export const XKB_VERSION = "2.48";

/**
 * Коды типов объектов по названию — из таблицы §1 приложения (колонка «Код»). Изделие — не тип объекта,
 * а Запись item (DATA-01): знак «@item». Заполняется при разборе §1.
 */
const OBJECT_CODES = new Map<string, string>();
/** Короткие названия объектов в §9 и §2. */
const OBJECT_ALIASES: Readonly<Record<string, string>> = {
  "Радио/Канал": "radio_channel",
  "Изделие": "@item",
  "Изделия": "@item",
  "любая связь": "@link",
  "Материал": "@material",
  "Запись": "@record",
  "любой узел": "@node",
};

/** Закрытые перечни полей программы (DICT-60). */
const CLOSED = new Set(["item_class", "item_subtype", "case_shape", "material_kind", "acquisition_method", "extraction_status"]);

/** Поля программы по Коду перечня (DATA-13; приложение §9 «поля программы»). */
const PROGRAM_FIELDS: Readonly<Record<string, string>> = {
  item_class: "itemClass",
  item_subtype: "itemSubtype",
  acquisition_method: "acquisitionMethod",
  extraction_status: "extractionStatus",
};

/** Секции markdown по заголовкам «## N.» и «### N.M». */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let key = "";
  let buf: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^#{2,3} (\d+(?:\.\d+)?)\.?\s/.exec(line);
    if (m !== null) {
      if (key !== "") out.set(key, buf.join("\n"));
      key = m[1]!;
      buf = [line];
    } else buf.push(line);
  }
  if (key !== "") out.set(key, buf.join("\n"));
  return out;
}

/** Строки таблиц секции: ячейки без внешних «|». */
function tableRows(section: string): string[][] {
  return section
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|[-| ]+\|$/.test(l))
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
}

/** Таблицы секции по одной, без строки заголовка. */
function tables(section: string): string[][][] {
  const out: string[][][] = [];
  let cur: string[][] | undefined;
  for (const l of section.split("\n")) {
    if (l.startsWith("|")) {
      if (/^\|[-| ]+\|$/.test(l)) continue;
      const cells = l.slice(1, -1).split("|").map((c) => c.trim());
      if (cur === undefined) {
        cur = [];
        out.push(cur);
        continue; // заголовок
      }
      cur.push(cells);
    } else cur = undefined;
  }
  return out;
}

const codesIn = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
const plain = (s: string): string => s.replace(/\*\*/g, "").replace(/`/g, "").trim();

function objectCodeOf(name: string): string {
  const n = plain(name).replace(/ разных Групп$/, "");
  const code = OBJECT_CODES.get(n) ?? OBJECT_ALIASES[n];
  if (code === undefined) throw new Error(`unknown object name: ${name}`);
  return code;
}

function parseObjects(s1: string): { objects: SourceObjectType[]; crossCompare: Map<string, string[]> } {
  const objects: SourceObjectType[] = [];
  const crossCompare = new Map<string, string[]>();
  OBJECT_CODES.clear();
  for (const [name = "", codeCell = "", kind = "", ident = ""] of tables(s1)[0] ?? []) {
    if (plain(name) === "Изделие") continue;
    const code = codesIn(codeCell)[0];
    if (code === undefined) throw new Error(`§1: у объекта ${name} нет Кода`);
    OBJECT_CODES.set(plain(name), code);
    const identifying = codesIn(ident);
    objects.push({ code, label: plain(name), role: kind === "часть" ? "part" : "node", identifying });
    if (ident.includes("сравниваются и между собой")) for (const c of identifying) crossCompare.set(c, identifying.filter((x) => x !== c));
  }
  return { objects, crossCompare };
}

function parseLinks(s2: string): SourceLinkType[] {
  return (tables(s2)[0] ?? []).map(([code = "", label = "", between = "", dir = ""]) => {
    const [from = "", to = ""] = between.split(/\s*[→↔]\s*/);
    const side = (s: string) => s.split(/,\s*|\s+или\s+/).map(objectCodeOf);
    return { code: codesIn(code)[0]!, label: plain(label), from: side(from), to: side(to), directed: dir.trim() === "направленная" };
  });
}

function parseIndicators(s6: string, crossCompare: Map<string, string[]>): SourceIndicatorType[] {
  const out: SourceIndicatorType[] = [];
  for (const part of s6.split(/\n(?=### 6\.\d+ )/).slice(1)) {
    const heading = /^### 6\.\d+ ([^(\n]+?)\s*(?:\(|$)/m.exec(part)?.[1] ?? "";
    const object = objectCodeOf(heading);
    for (const [code = "", label = "", format = "", c = "", cls = "", op = "", as = "", legacy = ""] of tables(part)[0] ?? []) {
      const opPlain = plain(op);
      const t: SourceIndicatorType = {
        code: codesIn(code)[0]!,
        label: plain(label),
        object,
        format: plain(format),
        comparable: plain(c) === "да",
        normClass: plain(cls) === "" ? null : plain(cls),
        identifying: opPlain.startsWith("С") ? "strict" : opPlain.startsWith("Н") ? "loose" : "none",
        autoSecret: plain(as) === "да",
        legacyNames: plain(legacy) === "—" || plain(legacy) === "" ? [] : plain(legacy).split(/,\s*/),
      };
      const cross = crossCompare.get(t.code);
      if (cross !== undefined) t.crossCompare = cross;
      out.push(t);
    }
  }
  return out;
}

function parseEnums(s7: string, sourcesDir: string | undefined, previous: SourceEnum[] | undefined): SourceEnum[] {
  const out: SourceEnum[] = [];
  for (const [code = "", values = ""] of tables(s7)[0] ?? []) {
    const c = codesIn(code)[0]!;
    if (c === "timezone" || c === "country" || c === "keyboard") {
      out.push(external(c, sourcesDir, previous));
      continue;
    }
    const vals = values.split(/;\s*/).map((seg) => {
      const m = /^`([^`]+)`\s*(.*)$/.exec(seg.trim());
      if (m === null) throw new Error(`enum ${c}: bad value ${seg}`);
      const label = plain(m[2]!) === "" ? m[1]! : plain(m[2]!);
      return { code: m[1]!, label };
    });
    out.push({ code: c, closed: CLOSED.has(c), values: vals });
  }
  return out;
}

function external(code: string, sourcesDir: string | undefined, previous: SourceEnum[] | undefined): SourceEnum {
  if (sourcesDir === undefined) {
    const found = previous?.find((e) => e.code === code);
    if (found === undefined) throw new Error(`enum ${code}: нужен каталог первоисточников`);
    return found;
  }
  if (code === "timezone") {
    const version = readFileSync(join(sourcesDir, "tz/version"), "utf8").trim();
    if (version !== TZDATA_VERSION) throw new Error(`tzdata ${version}, ожидается ${TZDATA_VERSION}`);
    const zones = new Set<string>();
    for (const file of ["zone1970.tab", "zone.tab"]) {
      for (const line of readFileSync(join(sourcesDir, "tz", file), "utf8").split("\n")) {
        if (line.startsWith("#") || line.trim() === "") continue;
        const name = line.split("\t")[2];
        if (name !== undefined) zones.add(name);
      }
    }
    zones.add("UTC");
    const aliases: Record<string, string> = {};
    for (const line of readFileSync(join(sourcesDir, "tz/backward"), "utf8").split("\n")) {
      const m = /^Link\s+(\S+)\s+(\S+)/.exec(line);
      if (m !== null && zones.has(m[1]!)) aliases[m[2]!] = m[1]!;
    }
    const values = [...zones].sort().map((z) => ({ code: z, label: z }));
    return { code, closed: false, values, aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1))) };
  }
  if (code === "country") {
    const values = [{ code: "00", label: "00" }];
    for (const line of readFileSync(join(sourcesDir, "tz/iso3166.tab"), "utf8").split("\n")) {
      if (line.startsWith("#") || line.trim() === "") continue;
      const [cc = "", name = ""] = line.split("\t");
      values.push({ code: cc, label: name.trim() });
    }
    return { code, closed: false, values };
  }
  const xml = readFileSync(join(sourcesDir, "base.xml"), "utf8");
  const layoutList = xml.slice(xml.indexOf("<layoutList>"), xml.indexOf("</layoutList>"));
  const values: { code: string; label: string }[] = [];
  for (const m of layoutList.matchAll(/<layout>\s*<configItem[^>]*>\s*<name>([^<]+)<\/name>[\s\S]*?<description>([^<]+)<\/description>/g)) {
    values.push({ code: m[1]!.trim(), label: m[2]!.trim() });
  }
  return { code: "keyboard", closed: false, values: values.sort((a, b) => (a.code < b.code ? -1 : 1)) };
}

/** Блоки §9 по Коду Класса: шапка, Носитель, ОС, блок Класса. */
function parseTemplates(s9: string, indicatorObjects: Map<string, string>, linkCodes: Set<string>): SourceTemplate[] {
  const blockTables = new Map<string, string[][]>();
  for (const part of s9.split(/\n(?=\*\*)/)) {
    const title = /^\*\*([^*]+)\*\*/.exec(part)?.[1];
    if (title === undefined) continue;
    blockTables.set(title, tables(part)[0] ?? []);
  }
  const DEFAULT_OBJECT: Record<string, string | undefined> = { media: "hw_element", os: "platform" };
  const NAMES = [...OBJECT_CODES.keys(), ...Object.keys(OBJECT_ALIASES)].sort((a, b) => b.length - a.length);
  const field = (row: string[], block: string): SourceField => {
    const [label = "", req = "", src = "", target = ""] = row;
    const t: SourceField["target"] = {};
    const codes = codesIn(target);
    const program = codes.filter((c) => PROGRAM_FIELDS[c] !== undefined).map((c) => PROGRAM_FIELDS[c]!);
    if (/поле программы|поля программы/.test(target)) {
      if (program.length > 0) t.programField = program.join(",");
      else if (target.includes("INTAKE-04")) t.programField = "acquisitionTool,intakeStation";
    }
    if (/Материал/.test(target)) t.material = true;
    // Объект поля — первый названный в «Куда ложится»; при равной позиции — более длинное название.
    let named: string | undefined;
    let at = Infinity;
    for (const n of NAMES) {
      const i = target.indexOf(n);
      if (i >= 0 && i < at) {
        at = i;
        named = n;
      }
    }
    const objectKind = named === undefined ? DEFAULT_OBJECT[block] : (OBJECT_CODES.get(named) ?? OBJECT_ALIASES[named]);
    if (objectKind !== undefined && objectKind !== "@material" && t.programField === undefined) t.objectKind = objectKind;
    const types = codes.filter((c) => indicatorObjects.has(c));
    if (types.length > 0) t.indicatorTypes = types;
    // Поле без названного объекта ложится в объект своих типов Индикаторов (§6): блок радиомодуля.
    if (t.objectKind === undefined && t.programField === undefined && types.length > 0) t.objectKind = indicatorObjects.get(types[0]!)!;
    const link = codes.find((c) => linkCodes.has(c));
    if (link !== undefined) t.link = link;
    const f: SourceField = { label: plain(label), required: plain(req).startsWith("О"), defaultSource: plain(src).startsWith("авто") ? "auto" : "manual", target: t };
    const extra = plain(req).replace(/^[Он]$/, "");
    if (extra !== "") f.note = extra;
    return f;
  };
  const block = (title: string, kind: "header" | "media" | "os" | "class") => {
    const rows = blockTables.get(title);
    if (rows === undefined) throw new Error(`§9: нет блока ${title}`);
    return { block: kind, fields: rows.map((r) => field(r, kind)) };
  };
  const header = block("Шапка Изделия", "header");
  const media = block("Блок «Носитель»", "media");
  const os = block("Блок «ОС»", "os");
  const companion = block("Блок companion-компьютера", "class");
  const fc = block("Блок полётного контроллера", "class");
  const radio = block("Блок радиомодуля (черновой)", "class");
  // Подтип «голый носитель» (§3): шапка + Носитель + terrain и логи полётов из блока ПК.
  const bare = { block: "class" as const, fields: fc.fields.filter((f) => /^Terrain|^Логи полётов/.test(f.label)) };
  const out: SourceTemplate[] = [
    { class: "companion", blocks: [header, media, os, companion] },
    { class: "flight_controller", blocks: [header, media, fc] },
    // ОС у радиомодуля — только если он на Linux (§3; DATA-23): блок есть, форма включает его по флагу.
    { class: "radio_module", blocks: [header, media, radio, os] },
  ];
  for (const cls of ["companion", "flight_controller", "radio_module"]) out.push({ class: cls, subtype: "bare_media", blocks: [header, media, bare] });
  return out;
}

function parseStopLists(s8: Map<string, string>): { lists: SourceStopList[]; expected: ExpectedStopList[] } {
  const meta = new Map<string, ExpectedStopList>();
  for (const [code = "", label = "", sec = "", source = "", rows = ""] of tables(s8.get("8") ?? "")[0] ?? []) {
    meta.set(plain(sec), { code: codesIn(code)[0]!, label: plain(label), section: plain(sec), source: plain(source), rows: Number(plain(rows).replace(/\s/g, "")) });
  }
  const builtAt = /Дата сборки списков версии 1 — (\d{4}-\d{2}-\d{2})/.exec(s8.get("8") ?? "")?.[1] ?? "";
  const kindOf = (k: string): "value" | "range" | "pattern" => (k === "значение" ? "value" : k === "диапазон" ? "range" : k === "шаблон" ? "pattern" : (() => { throw new Error(`kind ${k}`); })());
  const lists: SourceStopList[] = [];
  for (const sec of ["8.1", "8.3", "8.4", "8.5"]) {
    const m = meta.get(sec)!;
    const text = s8.get(sec) ?? "";
    const rows: SourceStopList["rows"] = [];
    const heading = /^### 8\.\d+ [^(]*\(`([^`]+)`, (\S+)\)/m.exec(text);
    for (const r of tables(text)[0] ?? []) {
      if (heading === null) {
        const [types = "", kind = "", values = "", note = ""] = r;
        for (const type of codesIn(types)) {
          for (const v of values.split(/;\s*/)) rows.push({ type, kind: kindOf(plain(kind)), value: plain(v), note: plain(note) });
        }
      } else if (sec === "8.4") {
        const [value = "", sign = ""] = r;
        rows.push({ type: heading[1]!, kind: kindOf(heading[2]!), value: plain(value), note: `контроллер ZeroTier Central; ${plain(sign)}` });
      } else {
        const [value = "", note = ""] = r;
        rows.push({ type: heading[1]!, kind: kindOf(heading[2]!), value: plain(value), note: plain(note) });
      }
    }
    lists.push({ format: "aristotel/stop-list/v1", code: m.code, label: m.label, source: m.source, builtAt, rows });
  }
  return { lists, expected: [...meta.values()] };
}


export function fromAppendix(text: string, sourcesDir: string | undefined, previousEnums?: SourceEnum[]): DictionarySource {
  const s = sections(text);
  const { objects, crossCompare } = parseObjects(s.get("1") ?? "");
  const linkTypes = parseLinks(s.get("2") ?? "");
  const six = [...s.entries()].filter(([k]) => k === "6" || k.startsWith("6.")).map(([, v]) => v).join("\n");
  const indicatorTypes = parseIndicators(six, crossCompare);
  const enums = parseEnums(s.get("7") ?? "", sourcesDir, previousEnums);
  const radio = enums.find((e) => e.code === "item_class")?.values.find((v) => v.code === "radio_module");
  if (radio !== undefined) radio.draft = true; // блок радиомодуля черновой (§3, DATA-24)
  const templates = parseTemplates(s.get("9") ?? "", new Map(indicatorTypes.map((t) => [t.code, t.object])), new Set(linkTypes.map((l) => l.code)));
  const eight = new Map([...s.entries()].filter(([k]) => k === "8" || k.startsWith("8.")));
  const stop = parseStopLists(eight);
  return {
    types: { objectTypes: objects, linkTypes, indicatorTypes },
    enums,
    classes: { templates },
    merges: { synonyms: [], localTypes: [], deprecated: [] },
    stopLists: stop.lists,
    expectedStopLists: stop.expected,
  };
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** Файлы исходника: путь относительно каталога → текст. */
export function sourceFiles(src: DictionarySource): Map<string, string> {
  const files = new Map<string, string>();
  files.set("types.json", json(src.types));
  files.set("enums.json", json(src.enums));
  files.set("classes.json", json(src.classes));
  files.set("merges.json", json(src.merges));
  files.set("stop-lists.json", json(src.expectedStopLists));
  for (const list of src.stopLists) files.set(`stop-lists/${list.code}.json`, json(list));
  return files;
}

if (import.meta.main) {
  const [appendix, outDir, sourcesDir] = process.argv.slice(2);
  if (appendix === undefined || outDir === undefined) {
    process.stderr.write("usage: node tools/slovar/from-appendix.ts <slovar-seti-v1.md> <out dir> [<sources dir>]\n");
    process.exit(2);
  }
  const prevPath = join(outDir, "enums.json");
  const previous = existsSync(prevPath) ? (JSON.parse(readFileSync(prevPath, "utf8")) as SourceEnum[]) : undefined;
  const src = fromAppendix(readFileSync(appendix, "utf8"), sourcesDir, previous);
  rmSync(join(outDir, "stop-lists"), { recursive: true, force: true });
  mkdirSync(join(outDir, "stop-lists"), { recursive: true });
  for (const [path, text] of sourceFiles(src)) writeFileSync(join(outDir, path), text);
  const t = src.types;
  process.stdout.write(
    `objects ${t.objectTypes.length}, links ${t.linkTypes.length}, indicators ${t.indicatorTypes.length}, enums ${src.enums.length}, templates ${src.classes.templates.length}, stop lists ${src.stopLists.map((l) => `${l.code}:${l.rows.length}`).join(" ")}\n`,
  );
}
