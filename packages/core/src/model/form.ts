// Описание Формуляра (research R13 фичи 005; DATA-14 … DATA-19, DATA-22, DATA-23, DICT-08): блоки по
// шаблону Класса из Словаря Сети — шапка, «Носитель» 0…N, «ОС» (у радиомодуля — только на Linux), блок
// Класса; общая часть Кейса; необязательные поля Местного расширения; поле устаревшего типа помечено.
// Формуляр — вид над Записями: отдельно хранимой карточки нет (DATA-22).
import { FORMAT_NAMES, GENERAL_PART, missingSections, type BankRecord, type GeneralPartField, type TemplateBlock } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import { ApiError } from "../api/errors.ts";
import { currentDictionary, type AppliedDictionary, type DictElement } from "../dictionary/current.ts";
import { answered, isStorageValue } from "./field-value.ts";
import { canSeeRecord, type Reader } from "../bank/visibility.ts";
import { registerCaseSummary } from "./case-view.ts";

export interface FormField {
  label: string;
  required: boolean;
  defaultSource: "auto" | "manual";
  target: Record<string, unknown>;
  local: boolean;
  deprecated: boolean;
  /** Тип значения (DATA-23): формат шаблона, иначе единственного типа или поля программы; нет — null. */
  format: string | null;
  /** Формат каждого типа Индикатора (по Идентификатору) и каждого поля программы (по имени). */
  formats: Record<string, string | null>;
}

/** Форматы полей программы с закрытыми перечнями (DICT-60); средство снятия и станция — строки. */
const PROGRAM_FIELD_FORMAT: Record<string, string> = {
  itemClass: `${FORMAT_NAMES.enum}:item_class`,
  itemSubtype: `${FORMAT_NAMES.enum}:item_subtype`,
  acquisitionMethod: `${FORMAT_NAMES.enum}:acquisition_method`,
  extractionStatus: `${FORMAT_NAMES.enum}:extraction_status`,
};

export interface FormDescription {
  class: string;
  subtype: string | null;
  general: readonly GeneralPartField[];
  blocks: { block: TemplateBlock; fields: FormField[] }[];
}

const BLOCK_ORDER: TemplateBlock[] = ["header", "media", "class", "os"];
const COMPANION_ORDER: TemplateBlock[] = ["header", "media", "os", "class"];

function enumValueByCode(dict: AppliedDictionary, enumCode: string, code: string): DictElement | undefined {
  return dict.enumValue(enumCode, code);
}

/** Описание Формуляра по Кодам Класса и подтипа; неизвестный — 400 invalid_request. */
export function formDescription(dict: AppliedDictionary, classCode: string, subtypeCode: string | undefined, onLinux: boolean): FormDescription {
  const cls = enumValueByCode(dict, "item_class", classCode);
  const sub = subtypeCode === undefined ? undefined : enumValueByCode(dict, "item_subtype", subtypeCode);
  if (cls === undefined || (subtypeCode !== undefined && sub === undefined)) throw new ApiError("invalid_request", { detail: `class=${classCode}${subtypeCode === undefined ? "" : ` subtype=${subtypeCode}`}` });
  const rows = dict.templates(cls.id, sub?.id ?? null);
  if (rows.length === 0) throw new ApiError("invalid_request", { detail: `class=${classCode} subtype=${subtypeCode ?? ""}` });
  const blocks = new Map<TemplateBlock, FormField[]>();
  for (const row of [...rows].sort((a, b) => Number(a.local) - Number(b.local) || a.position - b.position)) {
    const target = row.field.target;
    const types = (target.indicatorTypes ?? []) as string[];
    // Устаревшим поле делает тип Индикатора, вид объекта или тип связи, куда оно ложится (DICT-13).
    const deprecated = [...types, ...[target.objectKind, target.link].filter((id): id is string => typeof id === "string")].some(
      (id) => dict.element(dict.canonicalId(id))?.state === "deprecated",
    );
    // Поле ложится в несколько типов или полей программы (`itemClass,itemSubtype`): формат у каждого.
    const formats: Record<string, string | null> = {};
    for (const id of types) formats[id] = dict.indicatorType(id)?.format ?? null;
    if (typeof target.programField === "string") for (const name of target.programField.split(",")) formats[name.trim()] = PROGRAM_FIELD_FORMAT[name.trim()] ?? null;
    const single = Object.values(formats);
    const list = blocks.get(row.block) ?? [];
    list.push({
      label: row.field.label,
      // Поле Местного расширения всегда необязательное (DICT-08).
      required: row.local ? false : row.field.required,
      defaultSource: row.field.defaultSource,
      target: row.field.target as Record<string, unknown>,
      local: row.local,
      deprecated,
      format: row.field.format ?? (single.length === 1 ? single[0]! : null),
      formats,
    });
    blocks.set(row.block, list);
  }
  // Блок «ОС» у радиомодуля — только если он на Linux (§3; DATA-23); у companion — всегда.
  if (classCode === "radio_module" && !onLinux) blocks.delete("os");
  const order = blocks.has("os") && classCode !== "radio_module" ? COMPANION_ORDER : BLOCK_ORDER;
  return {
    class: cls.id,
    subtype: sub?.id ?? null,
    general: GENERAL_PART,
    blocks: order.filter((b) => blocks.has(b)).map((b) => ({ block: b, fields: blocks.get(b)! })),
  };
}

function classCodes(dict: AppliedDictionary, items: BankRecord[]): string[] {
  return items.map((i) => dict.element(String(i.fields["itemClass"]))?.code).filter((c): c is string => c !== undefined);
}

/** Отвеченность обязательных полей Формуляра Изделий (DATA-27): поле отвечено, если у его типов есть ответ. */
function itemsAnswered(db: Db, dict: AppliedDictionary, items: BankRecord[], reader?: Reader): string[] {
  // Запись в счёт — только видимая читающему: Секрет-Записи Наблюдателю ни Идентификатором, ни ответом
  // себя не выдают (VIEW-16, ROLE-24; T203).
  const visible = (r: Record<string, unknown>) => canSeeRecord(reader, Number(r["secret"]) === 1);
  const missing: string[] = [];
  for (const item of items) {
    const cls = dict.element(String(item.fields["itemClass"]));
    if (cls === undefined) continue;
    const sub = typeof item.fields["itemSubtype"] === "string" ? dict.element(item.fields["itemSubtype"]) : undefined;
    let form: FormDescription;
    try {
      form = formDescription(dict, cls.code, sub?.code, item.fields["onLinux"] === true);
    } catch {
      continue;
    }
    // Индикаторы Изделия: на нём самом, на его частях и на узлах, связанных с ним связями. Другое
    // Изделие на конце связи (connected_to, same_airframe) — не узел этого: его Индикаторы не в счёт (T195).
    const objectIds = new Set<string>([item.id]);
    for (const r of db.prepare("SELECT id, secret FROM record WHERE type = 'object' AND json_extract(fields, '$.item') = ?").all(item.id)) if (visible(r)) objectIds.add(String(r["id"]));
    for (const r of db
      .prepare(
        "SELECT o.id, o.secret, l.secret AS linkSecret FROM record l JOIN record o ON o.id = json_extract(l.fields, '$.to') WHERE l.type = 'link' AND o.type = 'object' AND json_extract(l.fields, '$.from') = ? AND (json_extract(o.fields, '$.item') IS NULL OR json_extract(o.fields, '$.item') = ?)",
      )
      // Часть чужого Изделия не отвечает поля этого (DATA-10; T299).
      .all(item.id, item.id))
      if (visible(r) && visible({ secret: r["linkSecret"] })) objectIds.add(String(r["id"]));
    const answeredTypes = answeredTypesOf(db, dict, objectIds, reader);
    const objectKinds = kindsOf(db, dict, objectIds);
    // Носители Изделия — Аппаратные элементы с hw_kind = носитель, связанные с Изделием (DATA-23).
    const media = [...objectIds].filter((id) => isMedia(db, dict, id, reader));
    for (const block of form.blocks) {
      if (block.block === "media") {
        // Носителей 0…N: поля блока спрашиваются у каждого Носителя, без Носителей — нет (DATA-23, DATA-27).
        for (const m of media) {
          const fields = (JSON.parse(String(db.prepare("SELECT fields FROM record WHERE id = ?").get(m)?.["fields"] ?? "{}")) as Record<string, unknown>);
          const types = answeredTypesOf(db, dict, new Set([m]), reader);
          for (const field of block.fields) if (field.required && !field.deprecated && !fieldAnswered(dict, field, fields, types, kindsOf(db, dict, new Set([m])))) missing.push(`${m}: ${field.label}`);
        }
        continue;
      }
      for (const field of block.fields) {
        if (!field.required || field.deprecated) continue;
        if (!fieldAnswered(dict, field, item.fields, answeredTypes, objectKinds)) missing.push(`${String(item.id)}: ${field.label}`);
      }
    }
  }
  return missing;
}

/** Типы Индикаторов, у которых на этих Записях есть ответ — значение или состояние пустого поля (DATA-27). */
function answeredTypesOf(db: Db, dict: AppliedDictionary, objectIds: Set<string>, reader: Reader | undefined): Set<string> {
  const out = new Set<string>();
  for (const id of objectIds) {
    for (const r of db.prepare("SELECT fields, secret FROM record WHERE type = 'indicator' AND json_extract(fields, '$.object') = ?").all(id)) {
      if (!canSeeRecord(reader, Number(r["secret"]) === 1)) continue;
      const f = JSON.parse(String(r["fields"])) as Record<string, unknown>;
      if (answered(f["value"]) || answered(f["state"] === undefined ? undefined : { state: f["state"], reason: f["reason"] })) out.add(dict.canonicalId(String(f["type"])));
    }
  }
  return out;
}

/** Поле отвечено: поле программы — значением в Записи; поле типов Индикаторов — ответом хоть по одному типу. */
function fieldAnswered(dict: AppliedDictionary, field: FormField, fields: Record<string, unknown>, answeredTypes: Set<string>, objectKinds: Set<string>): boolean {
  const program = field.target["programField"] as string | undefined;
  // Строка из нескольких полей программы отвечена, когда отвечено каждое поле: средство снятия и
  // станция приёмки — разные поля «Носителя» (DATA-27, DATA-13; T292). Подтип необязателен.
  if (program !== undefined) return program.split(",").every((p) => answered(fields[p]) || p === "itemSubtype");
  const types = (field.target["indicatorTypes"] as string[] | undefined) ?? [];
  if (types.length > 0) return types.some((t) => answeredTypes.has(dict.canonicalId(t)));
  // Поле только с видом объекта отвечено объектом этого вида у Изделия — частью или связанным узлом (DATA-27; T303).
  const kind = field.target["objectKind"];
  return typeof kind !== "string" || kind.startsWith("@") || objectKinds.has(dict.canonicalId(kind));
}

/** Канонические виды объектов среди данных Записей (для полей с одним видом объекта; T303). */
function kindsOf(db: Db, dict: AppliedDictionary, ids: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const row = db.prepare("SELECT json_extract(fields, '$.kind') AS kind FROM record WHERE id = ? AND type = 'object'").get(id);
    if (row !== undefined && row["kind"] !== null) out.add(dict.canonicalId(String(row["kind"])));
  }
  return out;
}

/** Носитель — Аппаратный элемент с Индикатором hw_kind = storage (приложение §9, блок «Носитель»). */
function isMedia(db: Db, dict: AppliedDictionary, id: string, reader: Reader | undefined): boolean {
  const hwKind = dict.byCode("indicator_type", "hw_kind");
  if (hwKind === undefined) return false;
  return db
    .prepare("SELECT fields, secret FROM record WHERE type = 'indicator' AND json_extract(fields, '$.object') = ?")
    .all(id)
    .some((r) => {
      if (!canSeeRecord(reader, Number(r["secret"]) === 1)) return false;
      const f = JSON.parse(String(r["fields"])) as Record<string, unknown>;
      return dict.canonicalId(String(f["type"])) === dict.canonicalId(hwKind.id) && isStorageValue(f["value"]);
    });
}

let registered = false;
/** Подключить Формуляр и скелет Отчёта к сводке Кейса (GET /api/cases/:id). */
export function registerFormSummary(): void {
  if (registered) return;
  registered = true;
  registerCaseSummary({
    answered: (db, _record, items, reader) => {
      const dict = currentDictionary(db);
      return dict === undefined ? [] : itemsAnswered(db, dict, items, reader);
    },
    missingSections: (db, record, items) => {
      const dict = currentDictionary(db);
      return missingSections(String(record.fields["report"] ?? ""), dict === undefined ? [] : classCodes(dict, items));
    },
  });
}
