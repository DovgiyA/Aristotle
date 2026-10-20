// Материализованный Словарь Сети: dict_element, dict_template, stop_list, stop_list_entry уровня Сети
// пересобираются из тела применённой версии одной транзакцией вызывающего (research R6 фичи 005;
// DICT-01). Строки Местного расширения (level = 'local', local = 1) не трогаются.
import { domainToASCII } from "node:url";
import { normalize, patternNormalForm, type SlovarBody, trimSpace } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";

const env = { toAscii: domainToASCII };

/**
 * Нормализованная форма строки Стоп-листа: «значение» — по Классу типа; шаблон — тоже, когда Класс
 * его принимает (`*.Пример.РФ` → A-метки, T245), иначе как есть; диапазон — как есть.
 */
export function stopEntryNormalized(kind: string, value: string, normClass: string | null | undefined): string {
  if (kind === "range" || normClass === null || normClass === undefined) return trimSpace(value);
  if (kind === "pattern") return patternNormalForm(normClass, value, env) ?? trimSpace(value);
  const n = normalize(normClass, value, env);
  return n.ok ? n.value : trimSpace(value);
}

export function materialize(db: Db, body: SlovarBody): void {
  db.prepare("DELETE FROM dict_element WHERE level = 'network'").run();
  const insertEl = db.prepare(
    "INSERT INTO dict_element (id, code, label, kind, level, state, canonicalId, sinceVersion, props) VALUES (?, ?, ?, ?, 'network', ?, ?, ?, ?)",
  );
  const normClass = new Map<string, string | null>();
  for (const el of body.elements) {
    insertEl.run(el.id, el.code, el.label, el.kind, el.state, el.canonical ?? null, el.sinceVersion, JSON.stringify(el.props));
    if (el.kind === "indicator_type") normClass.set(el.id, (el.props["normClass"] as string | null) ?? null);
  }
  db.prepare("DELETE FROM dict_template WHERE local = 0").run();
  const insertTpl = db.prepare("INSERT INTO dict_template (classId, subtypeId, block, position, field, local) VALUES (?, ?, ?, ?, ?, 0)");
  for (const tpl of body.templates) {
    let position = 0;
    for (const block of tpl.blocks) for (const field of block.fields) insertTpl.run(tpl.class, tpl.subtype ?? null, block.block, position++, JSON.stringify(field));
  }
  db.prepare("DELETE FROM stop_list_entry WHERE listId IN (SELECT id FROM stop_list WHERE level = 'network')").run();
  db.prepare("DELETE FROM stop_list WHERE level = 'network'").run();
  const insertList = db.prepare("INSERT INTO stop_list (id, code, label, source, builtAt, rows, level) VALUES (?, ?, ?, ?, ?, ?, 'network')");
  const insertEntry = db.prepare("INSERT INTO stop_list_entry (id, listId, typeId, kind, value, normalized, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const list of body.stopLists) {
    insertList.run(list.id, list.code, list.label, list.source, list.builtAt, list.rows.length);
    list.rows.forEach(([typeId, kind, value, note], i) => {
      insertEntry.run(`${list.id}:${i}`, list.id, typeId, kind, value, stopEntryNormalized(kind, value, normClass.get(typeId)), note);
    });
  }
}
