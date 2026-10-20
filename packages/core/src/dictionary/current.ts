// Применённый Словарь в памяти (research R6, R9, R10 фичи 005): элементы по Идентификатору и Коду,
// эффективные свойства (Сеть + ужесточения Местного расширения, DICT-07), канон по цепочке склеек
// (DICT-12), шаблоны Формуляра, Стоп-лист для совпадений. Загружается из материализованных таблиц;
// после применения версии и правки Местного расширения пересобирается (invalidateDictionary).
import { buildStopListMatcher, parseCidr, type StopListEntryInput, type StopListMatcher, type TemplateField, type TemplateBlock } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import { stopEntryNormalized } from "./materialize.ts";

export interface DictElement {
  id: string;
  code: string;
  label: string;
  kind: string;
  level: "network" | "local";
  state: "active" | "deprecated" | "absorbed";
  canonicalId: string | null;
  sinceVersion: number | null;
  props: Record<string, unknown>;
}

export interface IndicatorTypeProps {
  object: string;
  format: string;
  comparable: boolean;
  normClass: string | null;
  identifying: "strict" | "loose" | "none";
  autoSecret: boolean;
  crossCompare?: string[];
}

export interface TemplateRow {
  block: TemplateBlock;
  position: number;
  field: TemplateField & { deprecated?: boolean };
  local: boolean;
}

export interface StopListEntry extends StopListEntryInput {
  listId: string;
  value: string;
  note: string;
  /**
   * Строка не действует: `range`, чей канонический тип перестал быть `ip` (сменился Класс или тип
   * поглощён) или чьё значение — не CIDR. Так бывает только со строками «Местного»: Группа не может
   * отказаться от верной версии Сети (DICT-17), поэтому строка спит, а не роняет применение (T182).
   */
  dormant: boolean;
}

export interface StopListInfo {
  id: string;
  code: string;
  label: string;
  source: string;
  builtAt: string;
  rows: number;
  level: "network" | "local";
}

export class AppliedDictionary {
  readonly version: number;
  readonly bodySha256: string;
  readonly groupCode: string | undefined;
  private readonly byIdMap = new Map<string, DictElement>();
  private readonly byCodeMap = new Map<string, DictElement>();
  private readonly enumValuesMap = new Map<string, DictElement[]>();
  private readonly overrides = new Map<string, Map<string, unknown>>();
  private readonly templatesMap = new Map<string, TemplateRow[]>();
  readonly stopLists = new Map<string, StopListInfo>();
  readonly stopEntries = new Map<string, StopListEntry>();
  readonly stopMatcher: StopListMatcher;

  constructor(db: Db, version: number, bodySha256: string, groupCode: string | undefined) {
    this.version = version;
    this.bodySha256 = bodySha256;
    this.groupCode = groupCode;
    for (const r of db.prepare("SELECT * FROM dict_element").all()) {
      const el: DictElement = {
        id: String(r["id"]),
        code: String(r["code"]),
        label: String(r["label"]),
        kind: String(r["kind"]),
        level: String(r["level"]) as DictElement["level"],
        state: String(r["state"]) as DictElement["state"],
        canonicalId: r["canonicalId"] === null ? null : String(r["canonicalId"]),
        sinceVersion: r["sinceVersion"] === null ? null : Number(r["sinceVersion"]),
        props: JSON.parse(String(r["props"])) as Record<string, unknown>,
      };
      this.byIdMap.set(el.id, el);
      if (el.kind === "enum_value") {
        const list = this.enumValuesMap.get(String(el.props["enum"])) ?? [];
        list.push(el);
        this.enumValuesMap.set(String(el.props["enum"]), list);
      } else {
        this.byCodeMap.set(`${el.kind}:${el.code}`, el);
      }
    }
    for (const r of db.prepare("SELECT elementId, property, value FROM local_override").all()) {
      const map = this.overrides.get(String(r["elementId"])) ?? new Map<string, unknown>();
      map.set(String(r["property"]), JSON.parse(String(r["value"])));
      this.overrides.set(String(r["elementId"]), map);
    }
    for (const r of db.prepare("SELECT * FROM dict_template ORDER BY local, block, position").all()) {
      const key = `${String(r["classId"])}:${r["subtypeId"] === null ? "" : String(r["subtypeId"])}`;
      const list = this.templatesMap.get(key) ?? [];
      list.push({
        block: String(r["block"]) as TemplateBlock,
        position: Number(r["position"]),
        field: JSON.parse(String(r["field"])) as TemplateField,
        local: Number(r["local"]) === 1,
      });
      this.templatesMap.set(key, list);
    }
    for (const r of db.prepare("SELECT * FROM stop_list").all()) {
      this.stopLists.set(String(r["id"]), {
        id: String(r["id"]),
        code: String(r["code"]),
        label: String(r["label"]),
        source: String(r["source"]),
        builtAt: String(r["builtAt"]),
        rows: Number(r["rows"]),
        level: String(r["level"]) as StopListInfo["level"],
      });
    }
    for (const r of db.prepare("SELECT * FROM stop_list_entry").all()) {
      const typeId = this.canonicalId(String(r["typeId"]));
      const kind = String(r["kind"]) as StopListEntry["kind"];
      const value = String(r["value"]);
      // Строка сравнивается после нормализации по нынешнему Классу канонического типа (DICT-41): Класс
      // мог смениться версией Словаря, а строки «Местного» версия не пересобирает.
      const normClass = this.indicatorType(typeId)?.normClass;
      const normalized = stopEntryNormalized(kind, value, normClass);
      const e: StopListEntry = {
        id: String(r["id"]),
        listId: String(r["listId"]),
        typeId,
        kind,
        value,
        normalized,
        note: String(r["note"]),
        dormant: kind === "range" && (normClass !== "ip" || parseCidr(normalized) === undefined),
      };
      this.stopEntries.set(e.id, e);
    }
    const active = [...this.stopEntries.values()].filter((e) => !e.dormant);
    this.stopMatcher = buildStopListMatcher(active, (typeId) => this.indicatorType(typeId)?.normClass);
  }

  element(id: string): DictElement | undefined {
    return this.byIdMap.get(id);
  }

  elements(): IterableIterator<DictElement> {
    return this.byIdMap.values();
  }

  /** Элемент по виду и Коду (у значений перечня — enumValue). */
  byCode(kind: string, code: string): DictElement | undefined {
    return this.byCodeMap.get(`${kind}:${code}`);
  }

  enumValues(enumId: string): DictElement[] {
    return this.enumValuesMap.get(enumId) ?? [];
  }

  /** Значение перечня по Кодам перечня и значения. */
  enumValue(enumCode: string, valueCode: string): DictElement | undefined {
    const en = this.byCode("enum", enumCode);
    // Поглощённое местное значение уступает значению Сети с тем же Кодом (DICT-64; T211).
    if (en === undefined) return undefined;
    const values = this.enumValues(en.id).filter((v) => v.code === valueCode);
    return values.find((v) => v.state !== "absorbed") ?? values[0];
  }

  /** Канон по цепочке «поглощён → канон» (DICT-12); сам элемент, если не поглощён. */
  canonicalId(id: string): string {
    let current = id;
    for (let i = 0; i < 64; i++) {
      const el = this.byIdMap.get(current);
      if (el === undefined || el.state !== "absorbed" || el.canonicalId === null) return current;
      current = el.canonicalId;
    }
    return current;
  }

  /** Типы цепочки склеек от данного до канона (DICT-12). */
  private chain(id: string): string[] {
    const ids = [id];
    let current = id;
    for (let i = 0; i < 64; i++) {
      const el = this.byIdMap.get(current);
      if (el === undefined || el.state !== "absorbed" || el.canonicalId === null) break;
      current = el.canonicalId;
      ids.push(current);
    }
    return ids;
  }

  /**
   * Эффективные свойства типа Индикатора: свойства канона Сети и ужесточения Местного расширения
   * (DICT-07) — на любом типе цепочки склеек: местный автоматический Секрет поглощённого типа после
   * склейки сохраняется (ROLE-25).
   */
  indicatorType(id: string): IndicatorTypeProps | undefined {
    const ids = this.chain(id);
    const el = this.byIdMap.get(ids[ids.length - 1]!);
    if (el === undefined || el.kind !== "indicator_type") return undefined;
    const props = { ...(el.props as unknown as IndicatorTypeProps) };
    for (const typeId of ids) {
      // Собственный автоматический Секрет местного типа — ужесточение и после его склейки в тип Сети
      // (DICT-23, ROLE-25; T082, T190). Его «не опознаёт» (DICT-57) склейка как раз снимает.
      const own = this.byIdMap.get(typeId);
      if (own !== undefined && own.level === "local" && own.props["autoSecret"] === true) props.autoSecret = true;
      const local = this.overrides.get(typeId);
      if (local === undefined) continue;
      if (local.get("identifying") === "loose" && props.identifying === "strict") props.identifying = "loose";
      if (local.get("autoSecret") === true) props.autoSecret = true;
    }
    // Местный тип не опознаёт и не сопоставляется — ни в своей Группе, ни у других (DICT-06, DICT-57).
    if (el.level === "local") {
      props.identifying = "none";
      props.comparable = false;
    }
    return props;
  }

  templates(classId: string, subtypeId: string | null): TemplateRow[] {
    return this.templatesMap.get(`${classId}:${subtypeId ?? ""}`) ?? [];
  }
}

const cache = new WeakMap<Db, AppliedDictionary | null>();

function load(db: Db): AppliedDictionary | null {
  const row = db.prepare("SELECT number, bodySha256 FROM dictionary_version ORDER BY number DESC LIMIT 1").get();
  if (row === undefined) return null;
  const reg = db.prepare("SELECT document FROM registry_version ORDER BY number DESC LIMIT 1").get();
  let groupCode: string | undefined;
  if (reg !== undefined) {
    try {
      const doc = JSON.parse(String(reg["document"])) as { body: string };
      groupCode = (JSON.parse(doc.body) as { coordinatingGroup?: string; groups?: { code: string }[] }).groups?.[0]?.code;
    } catch {
      groupCode = undefined;
    }
  }
  return new AppliedDictionary(db, Number(row["number"]), String(row["bodySha256"]), groupCode);
}

/** Применённый Словарь; до версии 1 — undefined (тогда Записи модели не заводятся, dictionary_missing). */
export function currentDictionary(db: Db): AppliedDictionary | undefined {
  let value = cache.get(db);
  if (value === undefined) {
    value = load(db);
    cache.set(db, value);
  }
  return value ?? undefined;
}

/** Пересобрать Словарь в памяти: после применения версии и правки Местного расширения. */
export function invalidateDictionary(db: Db): void {
  cache.delete(db);
}
