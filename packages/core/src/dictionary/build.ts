// Сборка версии Словаря Сети из исходника — без службы (research R5 фичи 005; DICT-09 … DICT-13,
// DICT-16, NET-16). Идентификатор каждого Кода переходит из предыдущей версии; новому Коду —
// UUIDv7 (BANK-21); исчезнувший Код — отказ: элементы не удаляются, только устаревают (DICT-13).
import { randomUUIDv7 } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { domainToASCII } from "node:url";
import type { Static, TSchema } from "typebox";
import {
  PSEUDO_REFS,
  parseCidr,
  parseFormat,
  checkFormat,
  type FormatContext,
  programReadsByCode,
  programReadsElement,
  SLOVAR_FORMAT,
  SLOVAR_MAX_BODY_BYTES,
  bodySha256,
  isNormClass,
  message,
  normalize,
  parseSignedDocument,
  parseSlovarBody,
  parseStopListFile,
  SlovarFormatError,
  PROGRAM_ENUMS,
  MATERIAL_KINDS,
  SourceClassesFile,
  SourceEnumsFile,
  SourceExpectedStopListsFile,
  SourceMergesFile,
  SourceTypesFile,
  parseSourceFile,
  patternNormalForm,
  type DictionarySource,
  type MessageCode,
  type SignedDocument,
  type SlovarBody,
  type SlovarElement,
  type SourceStopList,
  type StopListFile,
  trimSpace,
} from "@aristotel/protocol";

export class DictionaryBuildError extends Error {}

/**
 * Файл исходника по схеме; нет файла, не JSON или не по схеме — SlovarFormatError с именем файла, а не
 * сбой сборки (T214).
 */
function readSourceFile<T extends TSchema>(path: string, schema: T): Static<T> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR") {
      throw new SlovarFormatError(message("slovar_file_invalid", { path, reason: message("slovar_file_missing") }));
    }
    throw error;
  }
  try {
    return parseSourceFile(text, schema);
  } catch (error) {
    if (error instanceof SlovarFormatError) throw new SlovarFormatError(message("slovar_file_invalid", { path, reason: error.message }));
    throw error;
  }
}

/** Прочитать каталог исходника (dictionary/source). */
export function readDictionarySource(dir: string): DictionarySource {
  const listDir = join(dir, "stop-lists");
  const stopLists = existsSync(listDir)
    ? readdirSync(listDir)
        .filter((n) => n.endsWith(".json"))
        .sort()
        .map((n) => {
          // Файл списка назван в причине: исходник — каталог многих файлов (T200).
          try {
            return parseStopListFile(readFileSync(join(listDir, n), "utf8")) as SourceStopList;
          } catch (error) {
            if (error instanceof SlovarFormatError) throw new SlovarFormatError(message("slovar_file_invalid", { path: n, reason: error.message }));
            throw error;
          }
        })
    : [];
  return {
    types: readSourceFile(join(dir, "types.json"), SourceTypesFile),
    enums: readSourceFile(join(dir, "enums.json"), SourceEnumsFile),
    classes: readSourceFile(join(dir, "classes.json"), SourceClassesFile),
    merges: readSourceFile(join(dir, "merges.json"), SourceMergesFile),
    stopLists,
    expectedStopLists: existsSync(join(dir, "stop-lists.json")) ? readSourceFile(join(dir, "stop-lists.json"), SourceExpectedStopListsFile) : [],
  };
}

export interface BuildReport {
  number: number;
  elements: Record<string, number>;
  stopLists: { code: string; rows: number }[];
  /** Списки §8 без значений в исходнике и без файла — собирает Сборщик (фича 023). */
  missingStopLists: string[];
  /** Списки предыдущей версии, перенесённые без нового файла (DICT-46). */
  carriedStopLists: string[];
  newElements: number;
}

export interface BuildInput {
  source: DictionarySource;
  /** Текст применённой предыдущей версии (aristotel dictionary export). */
  previous?: string;
  stopListFiles?: StopListFile[];
  issuedAt?: string;
}

const env = { toAscii: domainToASCII };

export function buildVersion(input: BuildInput): { doc: SignedDocument; report: BuildReport } {
  const fail = (code: MessageCode, params: Record<string, string> = {}): never => {
    throw new DictionaryBuildError(message("dictionary_reason_content", { detail: message(code, params) }));
  };
  const src = input.source;
  let prev: SlovarBody | undefined;
  let prevSha: string | null = null;
  if (input.previous !== undefined) {
    const doc = parseSignedDocument(input.previous, SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES });
    prev = parseSlovarBody(doc.body);
    prevSha = bodySha256(doc.body);
  }
  const number = (prev?.number ?? 0) + 1;

  // Ключ элемента — «вид:код», у значения перечня — «enum_value:<перечень>.<код>». Состояние прежней
  // версии («поглощён → канон», «устарел») переходит в следующую: назад в «действует» элемент не
  // возвращается (DICT-12, DICT-13).
  const prevIds = new Map<string, { id: string; since: number; state: SlovarElement["state"]; canonical?: string }>();
  if (prev !== undefined) {
    const enumCode = new Map(prev.elements.filter((e) => e.kind === "enum").map((e) => [e.id, e.code]));
    for (const e of prev.elements) {
      const key = e.kind === "enum_value" ? `enum_value:${enumCode.get(String(e.props["enum"]))}.${e.code}` : `${e.kind}:${e.code}`;
      prevIds.set(key, { id: e.id, since: e.sinceVersion, state: e.state, ...(e.canonical === undefined ? {} : { canonical: e.canonical }) });
    }
    for (const l of prev.stopLists) prevIds.set(`stop_list:${l.code}`, { id: l.id, since: 0, state: "active" });
  }
  // Смена Кода: Идентификатор прежнего Кода переходит к новому (DICT-10); у перечня — и его значениям.
  const renamed = src.merges.renamed ?? [];
  const enumOfValue = (key: string) => key.slice("enum_value:".length, key.indexOf("."));
  const sameEnum = (from: string, to: string) => {
    const a = enumOfValue(from);
    const b = enumOfValue(to);
    return a === b || renamed.some((r) => r.from === `enum:${a}` && r.to === `enum:${b}`);
  };
  for (const r of renamed) {
    const known = prevIds.get(r.from);
    const kindOf = (key: string) => key.slice(0, key.indexOf(":"));
    if (known === undefined) fail("content_rename_unknown", { key: r.from });
    else if (kindOf(r.from) !== kindOf(r.to)) fail("content_rename_kind", { from: r.from, to: r.to });
    // Значение остаётся в своём перечне (или в нём же под новым Кодом перечня) — как при применении (T183; T231).
    else if (r.from.startsWith("enum_value:") && !sameEnum(r.from, r.to)) fail("content_rename_enum", { from: r.from, to: r.to });
    else if (prevIds.has(r.to)) fail("content_rename_taken", { to: r.to });
    // Закрытые перечни полей программы программа находит по Коду (DICT-60, BANK-63).
    else if (readByCode(r.from)) fail("content_program_code", { code: r.from });
    else {
      prevIds.delete(r.from);
      prevIds.set(r.to, known);
    }
    if (r.from.startsWith("enum:") && r.to.startsWith("enum:")) {
      const from = `enum_value:${r.from.slice(5)}.`;
      for (const [key, value] of [...prevIds]) {
        if (!key.startsWith(from)) continue;
        prevIds.delete(key);
        prevIds.set(`enum_value:${r.to.slice(5)}.${key.slice(from.length)}`, value);
      }
    }
  }
  let newElements = 0;
  const ids = new Map<string, string>();
  const idOf = (key: string): string => {
    let id = ids.get(key);
    if (id === undefined) {
      const known = prevIds.get(key);
      if (known === undefined && !key.startsWith("stop_list:")) newElements++;
      id = known?.id ?? randomUUIDv7();
      ids.set(key, id);
    }
    return id;
  };
  const sinceOf = (key: string) => prevIds.get(key)?.since ?? number;

  // Ссылка на элемент по Коду: Код должен быть в исходнике, иначе — отказ (DICT-10; T163).
  const referenced = new Set<string>();
  const refOf = (key: string): string => {
    referenced.add(key);
    return idOf(key);
  };
  const objectRef = (code: string) => {
    if (!code.startsWith("@")) return refOf(`object_type:${code}`);
    if (!(PSEUDO_REFS as readonly string[]).includes(code)) fail("content_ref_unknown", { key: code });
    return code;
  };
  const deprecated = new Set(src.merges.deprecated);
  // Один поглощённый — один канон; повтор той же склейки допустим (DICT-12, DICT-22; T232).
  const synonyms = new Map<string, string>();
  for (const s of src.merges.synonyms) {
    if (synonyms.has(s.absorbed) && synonyms.get(s.absorbed) !== s.canonical) fail("content_merge_twice", { code: s.absorbed });
    synonyms.set(s.absorbed, s.canonical);
  }
  const localCanon = new Map<string, string>();
  for (const m of src.merges.localTypes) {
    if (localCanon.has(m.localId) && localCanon.get(m.localId) !== m.canonical) fail("content_merge_twice", { code: m.local });
    localCanon.set(m.localId, m.canonical);
  }
  const elements: SlovarElement[] = [];
  const elementKeys = new Set<string>();
  const push = (kind: SlovarElement["kind"], code: string, label: string, props: Record<string, unknown>, key = `${kind}:${code}`) => {
    elementKeys.add(key);
    const before = prevIds.get(key);
    const synonym = synonyms.get(key);
    const canonical = synonym !== undefined ? idOf(synonym) : before?.state === "absorbed" ? before.canonical : undefined;
    // Канон поглощённого не меняется (DICT-12): повтор той же склейки в merges.json допустим.
    if (before?.state === "absorbed" && canonical !== before.canonical) fail("content_canonical_changed", { code });
    const el: SlovarElement = {
      id: idOf(key),
      code,
      label,
      kind,
      state: canonical !== undefined ? "absorbed" : deprecated.has(key) || before?.state === "deprecated" ? "deprecated" : "active",
      sinceVersion: sinceOf(key),
      props,
    };
    if (canonical !== undefined) el.canonical = canonical;
    elements.push(el);
  };

  for (const o of src.types.objectTypes) {
    const props: Record<string, unknown> = { role: o.role };
    if (o.identifying.length > 0) props["identifying"] = o.identifying.map((c) => refOf(`indicator_type:${c}`));
    push("object_type", o.code, o.label, props);
  }
  for (const l of src.types.linkTypes) push("link_type", l.code, l.label, { from: l.from.map(objectRef), to: l.to.map(objectRef), directed: l.directed });
  const normClassOfType = new Map<string, string | null>();
  const enumCodes = new Set(src.enums.map((e) => e.code));
  for (const t of src.types.indicatorTypes) {
    if (t.normClass !== null && !isNormClass(t.normClass)) fail("content_norm_class_unknown", { code: t.code, cls: t.normClass });
    // Формат разбирается этой версией программы; перечень формата — из этой версии (§5; T147).
    let format: ReturnType<typeof parseFormat> | undefined;
    try {
      format = parseFormat(t.format);
    } catch {
      fail("content_format_unknown", { code: t.code, format: t.format });
    }
    if (format?.kind === "enum" && !enumCodes.has(format.enumCode)) fail("content_format_enum_missing", { code: t.code, enum: format.enumCode });
    // Перечень поля программы закрыт — тип Индикатора его не берёт: значения вне перечня — «вне Словаря» (T304).
    if (format?.kind === "enum" && (PROGRAM_ENUMS as readonly string[]).includes(format.enumCode)) fail("content_program_enum_format", { code: t.code, enum: format.enumCode });
    normClassOfType.set(t.code, t.normClass);
    const props: Record<string, unknown> = {
      object: objectRef(t.object),
      format: t.format,
      comparable: t.comparable,
      normClass: t.normClass,
      identifying: t.identifying,
      autoSecret: t.autoSecret,
    };
    if (t.crossCompare !== undefined) props["crossCompare"] = t.crossCompare.map((c) => refOf(`indicator_type:${c}`));
    if (t.legacyNames.length > 0) props["legacyNames"] = t.legacyNames;
    push("indicator_type", t.code, t.label, props);
  }
  // Синонимы перечня: из исходника, прежней версии и смены Кода значения — прежний Код остаётся
  // читаемым, значения Индикаторов не становятся «вне Словаря» (DICT-10; T259).
  const renamedValueAliases = new Map<string, Record<string, string>>();
  for (const r of renamed) {
    if (!r.from.startsWith("enum_value:") || !r.to.startsWith("enum_value:")) continue;
    const toEnum = r.to.slice("enum_value:".length, r.to.indexOf("."));
    const oldCode = r.from.slice(r.from.indexOf(".") + 1);
    const newCode = r.to.slice(r.to.indexOf(".") + 1);
    if (oldCode !== newCode) renamedValueAliases.set(toEnum, { ...(renamedValueAliases.get(toEnum) ?? {}), [oldCode]: newCode });
  }
  const prevEnumAliases = new Map((prev?.elements ?? []).filter((e) => e.kind === "enum").map((e) => [e.id, (e.props["aliases"] as Record<string, string> | undefined) ?? {}]));
  for (const e of src.enums) {
    const props: Record<string, unknown> = { closed: e.closed };
    const aliases = { ...(prevEnumAliases.get(idOf(`enum:${e.code}`)) ?? {}), ...(renamedValueAliases.get(e.code) ?? {}), ...(e.aliases ?? {}) };
    if (Object.keys(aliases).length > 0) props["aliases"] = aliases;
    push("enum", e.code, e.code, props);
    for (const v of e.values) {
      const vp: Record<string, unknown> = { enum: idOf(`enum:${e.code}`) };
      if (v.draft === true) vp["draft"] = true;
      push("enum_value", v.code, v.label, vp, `enum_value:${e.code}.${v.code}`);
    }
  }
  // Перечни полей программы — только закрытые: иначе Группа дополнила бы их местно (DICT-60; T204).
  for (const e of src.enums) if ((PROGRAM_ENUMS as readonly string[]).includes(e.code) && e.closed !== true) fail("content_program_enum_open", { code: e.code });
  // Закрыты только перечни полей программы (DICT-14, DICT-60; T300).
  for (const e of src.enums) if (!(PROGRAM_ENUMS as readonly string[]).includes(e.code) && e.closed === true) fail("content_enum_closed_not_program", { code: e.code });
  // Код уникален среди элементов своего вида в Сети (DICT-11, DICT-64); значение перечня — внутри перечня.
  const seen = new Set<string>();
  for (const e of elements) {
    const key = e.kind === "enum_value" ? `${e.kind}:${String(e.props["enum"])}.${e.code}` : `${e.kind}:${e.code}`;
    if (seen.has(key)) fail("content_code_repeat", { code: e.code });
    seen.add(key);
  }
  // Элемент прежней версии не пропадает (DICT-13): он может только устареть.
  for (const [key] of prevIds) if (!key.startsWith("stop_list:") && !ids.has(key)) fail("content_source_gone", { key });
  // Синоним — между известными элементами одного вида, не сам в себя (DICT-12).
  // Синоним — между типами одного вида или значениями одного перечня; перечни не склеиваются.
  const roleOf = (key: string) => src.types.objectTypes.find((o) => `object_type:${o.code}` === key)?.role;
  const groupOf = (key: string) => (key.startsWith("enum_value:") ? key.slice(0, key.indexOf(".")) : key.slice(0, key.indexOf(":")));
  for (const syn of src.merges.synonyms) {
    if (!elementKeys.has(syn.absorbed) || !elementKeys.has(syn.canonical)) fail("content_merge_missing");
    if (syn.absorbed === syn.canonical) fail("content_merge_self", { code: syn.absorbed });
    if (syn.absorbed.startsWith("enum:") || groupOf(syn.absorbed) !== groupOf(syn.canonical)) fail("content_merge_kind", { code: syn.absorbed });
    // Вид объекта склеивается только с видом той же роли: узел — с узлом, часть Изделия — с частью (T199).
    if (syn.absorbed.startsWith("object_type:") && roleOf(syn.absorbed) !== roleOf(syn.canonical)) fail("content_merge_role", { code: syn.absorbed });
    if (readByCode(syn.absorbed)) fail("content_program_code", { code: syn.absorbed });
  }
  const cycle = absorptionCycle(elements);
  if (cycle !== undefined) fail("content_merge_cycle", { code: cycle });
  // Устаревший — известный элемент: опечатка иначе молча оставила бы его действующим (DICT-13; T219).
  for (const key of src.merges.deprecated) if (!elementKeys.has(key)) fail("content_deprecated_unknown", { key });
  // Шаблон — один на Класс и подтип (DATA-23; T217).
  const templateKeys = new Set<string>();
  for (const tpl of src.classes.templates) {
    const key = `${tpl.class}:${tpl.subtype ?? ""}`;
    if (templateKeys.has(key)) fail("content_template_repeat", { class: key });
    templateKeys.add(key);
  }

  const valueId = (enumCode: string, code: string) => {
    const key = `enum_value:${enumCode}.${code}`;
    if (!ids.has(key)) fail("content_enum_value_missing", { key });
    return idOf(key);
  };
  const templates: SlovarBody["templates"] = src.classes.templates.map((tpl) => {
    const out: SlovarBody["templates"][number] = {
      class: valueId("item_class", tpl.class),
      blocks: tpl.blocks.map((b) => ({
        block: b.block,
        fields: b.fields.map((f) => {
          const target: Record<string, unknown> = {};
          if (f.target.programField !== undefined) target["programField"] = f.target.programField;
          if (f.target.objectKind !== undefined) target["objectKind"] = objectRef(f.target.objectKind);
          if (f.target.indicatorTypes !== undefined) target["indicatorTypes"] = f.target.indicatorTypes.map((c) => refOf(`indicator_type:${c}`));
          if (f.target.link !== undefined) target["link"] = refOf(`link_type:${f.target.link}`);
          if (f.target.material === true) target["material"] = true;
          // Формат поля шаблона — как формат типа: разбирается этой версией, перечень — из версии (T248).
          if (f.format !== undefined) {
            let parsed: ReturnType<typeof parseFormat> | undefined;
            try {
              parsed = parseFormat(f.format);
            } catch {
              fail("content_format_unknown", { code: f.label, format: f.format });
            }
            if (parsed?.kind === "enum" && !enumCodes.has(parsed.enumCode)) fail("content_format_enum_missing", { code: f.label, enum: parsed.enumCode });
          }
          return {
            label: f.label,
            required: f.required,
            defaultSource: f.defaultSource,
            target,
            ...(f.format === undefined ? {} : { format: f.format }),
            ...(f.note === undefined ? {} : { note: f.note }),
          };
        }),
      })),
    };
    if (tpl.subtype !== undefined) out.subtype = valueId("item_subtype", tpl.subtype);
    return out;
  });

  const lists = [...src.stopLists, ...(input.stopListFiles ?? [])];
  // Строка списка: тип из Словаря, «диапазон» — только у ip, «значение» нормализуется (DICT-41).
  const normClassById = new Map(elements.filter((e) => e.kind === "indicator_type").map((e) => [e.id, e.props["normClass"] as string | null]));
  // Класс строки — нынешний Класс канонического типа: тип мог быть поглощён (DICT-41; T182).
  const elementById = new Map(elements.map((e) => [e.id, e]));
  const canonOf = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 64; i++) {
      const el = elementById.get(cur);
      if (el === undefined || el.state !== "absorbed" || el.canonical === undefined) return cur;
      cur = el.canonical;
    }
    return cur;
  };
  const formatById = new Map(elements.filter((e) => e.kind === "indicator_type").map((e) => [e.id, e.props["format"]]));
  const formatCtx = elementsFormatContext(elements);
  const checkRow = (list: string, typeId: string, typeName: string, kind: string, value: string, dup: Set<string>): void => {
    if (!normClassById.has(typeId)) fail("content_stop_type_unknown", { list, type: typeName });
    // «Значение» проверяется Классом своего типа (сравнение — по канону при загрузке, T083); «диапазон» —
    // Классом канона: строку range не-ip типа Стоп-лист не соберёт (T182).
    const cls = normClassById.get(typeId);
    if (kind === "range" && normClassById.get(canonOf(typeId)) !== "ip") fail("content_range_not_ip", { list, type: typeName });
    if (cls === undefined) fail("content_stop_type_unknown", { list, type: typeName });
    if (kind === "range" && parseCidr(trimSpace(value)) === undefined) fail("content_range_invalid", { list, value });
    let norm = trimSpace(value);
    if (kind === "value" && stopValueBreaksFormat(formatById.get(typeId), value, formatCtx)) fail("content_stop_format", { list, value });
    if (kind === "value" && cls !== null && cls !== undefined) {
      const n = normalize(cls, value, env);
      if (!n.ok) fail("content_stop_not_normalizable", { list, value, cls });
      else norm = n.value;
    }
    // Шаблон — в нормальной форме Класса, иначе он не совпадёт ни с чем; повтор — по ней (T258).
    if (kind === "pattern") {
      const nf = patternNormalForm(cls, value, env);
      if (nf === undefined) fail("content_stop_pattern_not_normal", { list, value, cls: String(cls) });
      else norm = nf;
    }
    const key = `${typeId}\u0000${kind}\u0000${norm}`;
    if (dup.has(key)) fail("content_stop_repeat", { list, type: typeName, value });
    dup.add(key);
  };
  const stopLists: SlovarBody["stopLists"] = lists.map((l) => {
    const dup = new Set<string>();
    const rows = l.rows.map((r): [string, "value" | "range" | "pattern", string, string] => {
      if (!normClassOfType.has(r.type)) fail("content_stop_type_unknown", { list: l.code, type: r.type });
      const typeId = idOf(`indicator_type:${r.type}`);
      checkRow(l.code, typeId, r.type, r.kind, r.value, dup);
      return [typeId, r.kind, r.value, r.note];
    });
    return { id: idOf(`stop_list:${l.code}`), code: l.code, label: l.label, source: l.source, builtAt: l.builtAt, rows };
  });
  const listCodes = new Set(stopLists.map((l) => l.code));
  if (listCodes.size !== stopLists.length) fail("content_list_repeat");
  // Переименованный список должен быть в версии под новым Кодом, иначе переименование потерялось бы.
  for (const r of renamed) if (r.to.startsWith("stop_list:") && !listCodes.has(r.to.slice("stop_list:".length))) fail("content_rename_list_missing", { to: r.to });
  // Список прежней версии без нового файла переходит целиком: Стоп-лист едет в каждой версии (DICT-46).
  // Переименованный (renamed «stop_list:…») уже в версии под новым Кодом — по Идентификатору.
  const carriedStopLists: string[] = [];
  const listIds = new Set(stopLists.map((l) => l.id));
  for (const l of prev?.stopLists ?? []) {
    if (listCodes.has(l.code) || listIds.has(l.id)) continue;
    // Строки перенесённого списка проверяются заново: Класс типа мог смениться (DICT-41).
    const dup = new Set<string>();
    for (const [typeId, kind, value] of l.rows) checkRow(l.code, typeId, typeId, kind, value, dup);
    stopLists.push(structuredClone(l));
    listCodes.add(l.code);
    carriedStopLists.push(l.code);
  }

  // Переименованный Код не остаётся в исходнике: иначе у него новый Идентификатор (DICT-10).
  for (const r of renamed) if (ids.has(r.from)) fail("content_rename_present", { from: r.from });

  const merges: SlovarBody["merges"] = [
    ...src.merges.synonyms.map((s) => ({ absorbed: idOf(s.absorbed), canonical: idOf(s.canonical) })),
    ...src.merges.localTypes.map((m) => ({ local: m.local, localId: m.localId, canonical: refOf(`indicator_type:${m.canonical}`) })),
  ];
  for (const key of referenced) if (!elementKeys.has(key)) fail("content_ref_unknown", { key });
  const normClasses = [...new Set(src.types.indicatorTypes.map((t) => t.normClass).filter((c): c is string => c !== null))].sort();
  const materialKinds = (src.enums.find((e) => e.code === "material_kind")?.values ?? []).map((v) => v.code);
  // Вид Материала — из кода программы: неизвестный эта программа и применить не сможет (DICT-01; T235).
  for (const k of materialKinds) if (!(MATERIAL_KINDS as readonly string[]).includes(k)) fail("content_material_kind_unknown", { kind: k });
  const body: SlovarBody = {
    number,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    previousSha256: prevSha,
    programRequirements: { normClasses, materialKinds },
    elements,
    templates,
    stopLists,
    merges,
  };
  const text = JSON.stringify(body);
  parseSlovarBody(text);
  const counts: Record<string, number> = {};
  for (const e of elements) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return {
    doc: { format: SLOVAR_FORMAT, body: text, signatures: [] },
    report: {
      number,
      elements: counts,
      stopLists: stopLists.map((l) => ({ code: l.code, rows: l.rows.length })),
      missingStopLists: src.expectedStopLists.map((e) => e.code).filter((c) => !listCodes.has(c)),
      carriedStopLists,
      newElements,
    },
  };
}

/**
 * Цикл в цепочках «поглощён → канон» (DICT-12): Код первого элемента цикла или undefined. Общая для
 * сборки и применения версии.
 */
/**
 * Контекст проверки формата по элементам версии (без применённого Словаря): значения перечней и их
 * синонимы — из тех же элементов (приложение §8; T278).
 */
export function elementsFormatContext(elements: readonly SlovarElement[]): FormatContext {
  const enums = new Map(elements.filter((e) => e.kind === "enum").map((e) => [e.code, e]));
  return {
    toAscii: domainToASCII,
    enumCodes: (code) => {
      const en = enums.get(code);
      if (en === undefined) return undefined;
      const aliases = Object.keys((en.props["aliases"] as Record<string, string> | undefined) ?? {});
      return new Set([...elements.filter((e) => e.kind === "enum_value" && e.props["enum"] === en.id).map((e) => e.code), ...aliases]);
    },
    closedEnum: (code) => enums.get(code)?.props["closed"] === true,
  };
}

/** Значение строки Стоп-листа не по формату своего типа (приложение §8; T278). */
export function stopValueBreaksFormat(format: unknown, value: string, ctx: FormatContext): boolean {
  try {
    const r = checkFormat(parseFormat(String(format)), value, ctx);
    return r === "format_violation" || r === "not_a_value";
  } catch {
    return true;
  }
}

export function absorptionCycle(elements: readonly SlovarElement[]): string | undefined {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const start of elements) {
    if (start.state !== "absorbed") continue;
    const seen = new Set<string>([start.id]);
    let current = start.canonical === undefined ? undefined : byId.get(start.canonical);
    while (current !== undefined && current.state === "absorbed") {
      if (seen.has(current.id)) return start.code;
      seen.add(current.id);
      current = current.canonical === undefined ? undefined : byId.get(current.canonical);
    }
  }
  return undefined;
}

/** Ключ «вид:код» элемента или значения, которое программа находит по Коду (DICT-60; T146, T162). */
function readByCode(key: string): boolean {
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (kind !== "enum_value") return programReadsElement(kind, rest);
  const dot = rest.indexOf(".");
  return dot > 0 && programReadsByCode(rest.slice(0, dot), rest.slice(dot + 1));
}
