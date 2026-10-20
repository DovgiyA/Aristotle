// Подписи объектов модели (research R14 фичи 005; BANK-32, BANK-35): Кейс — Номер, чужой Кейс — с Кодом
// Группы через «·» (U+00B7); объект — по опознающему Индикатору; связь — через концы; Индикатор —
// через свой объект. Одна функция для API, CLI и будущих видов (фичи 008, 011).
import { message } from "@aristotel/protocol";
import type { Db } from "../db/open.ts";
import type { AppliedDictionary } from "../dictionary/current.ts";
import { canSeeRecord, type Reader } from "../bank/visibility.ts";

/** Кейс: свой — Номер; чужой (ownerGroup ≠ своей) — `<Код Группы>·Номер` (BANK-32). */
export function caseLabel(number: string, ownerGroup: string | undefined, ownGroup: string | undefined): string {
  return ownerGroup === undefined || ownerGroup === ownGroup ? number : `${ownerGroup}·${number}`;
}

interface Row {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  secret: boolean;
}

function row(db: Db, id: unknown): Row | undefined {
  if (typeof id !== "string") return undefined;
  const r = db.prepare("SELECT id, type, fields, secret FROM record WHERE id = ?").get(id);
  return r === undefined ? undefined : { id: String(r["id"]), type: String(r["type"]), fields: JSON.parse(String(r["fields"])) as Record<string, unknown>, secret: Number(r["secret"]) === 1 };
}

/** Номер Кейса для подписи; Секрет-Кейса Наблюдатель не видит — «—» (VIEW-16). */
function caseNumberOf(db: Db, caseId: unknown, reader: Reader | undefined): string {
  const c = row(db, caseId);
  return c === undefined || !canSeeRecord(reader, c.secret) ? "—" : String(c.fields["number"] ?? "—");
}

/** Подпись Записи модели по её типу; для Наблюдателя Секрет-Индикаторы в подпись не идут. */
export function recordLabel(db: Db, dict: AppliedDictionary | undefined, id: unknown, reader?: Reader, depth = 0): string {
  const r = row(db, id);
  if (r === undefined || depth > 3) return "—";
  // Запись, на которую ссылается подпись (конец связи, объект Индикатора), Наблюдатель может не видеть:
  // Секрет-Записей у него нет без следа — ни имени, ни Номера (VIEW-16, BANK-35).
  if (depth > 0 && !canSeeRecord(reader, r.secret)) return "—";
  // Подпись типа поглощённого — по Подписи канона: Записи читаются как значения канонического типа
  // (DICT-12; T236).
  const label = (elId: unknown) => (typeof elId === "string" ? (dict?.element(dict.canonicalId(elId))?.label ?? elId) : "—");
  switch (r.type) {
    case "case":
      return caseLabel(String(r.fields["number"]), undefined, undefined);
    case "item":
      return `${label(r.fields["itemClass"])} · ${caseNumberOf(db, r.fields["case"], reader)}`;
    case "object": {
      // По первому видимому опознающему Индикатору — в порядке типов Словаря (BANK-35).
      // Опознающие типы — у канонического вида объекта (DICT-12; T198).
      const kind = dict?.element(dict.canonicalId(String(r.fields["kind"])));
      const identifying = (kind?.props["identifying"] as string[] | undefined) ?? [];
      // Только опознающее значение: строка Стоп-листа или «не нормализуется» объект не называет (DICT-40).
      const values = db
        .prepare(
          "SELECT r.fields, r.secret FROM record r JOIN indicator_value v ON v.recordId = r.id WHERE r.type = 'indicator' AND v.identifying = 1 AND json_extract(r.fields, '$.object') = ?",
        )
        .all(r.id)
        .map((x) => ({ fields: JSON.parse(String(x["fields"])) as Record<string, unknown>, secret: Number(x["secret"]) === 1 }))
        .filter((x) => canSeeRecord(reader, x.secret) && typeof x.fields["value"] === "string");
      for (const typeId of identifying) {
        const found = values.find((v) => dict?.canonicalId(String(v.fields["type"])) === dict?.canonicalId(typeId));
        if (found !== undefined) return String(found.fields["value"]);
      }
      return `${label(r.fields["kind"])} · — · ${caseNumberOf(db, r.fields["case"], reader)}`;
    }
    case "link":
      return `${recordLabel(db, dict, r.fields["from"], reader, depth + 1)} — ${label(r.fields["type"])} → ${recordLabel(db, dict, r.fields["to"], reader, depth + 1)}`;
    case "indicator": {
      const value = typeof r.fields["value"] === "string" ? r.fields["value"] : "—";
      return `${label(r.fields["type"])}: ${value} (${recordLabel(db, dict, r.fields["object"], reader, depth + 1)})`;
    }
    case "material": {
      // Материал: путь и Номер Кейса; удалённый — с пометкой, связь «подтверждается» к нему остаётся (BANK-12, DATA-12).
      const path = String(r.fields["path"] ?? "—");
      const deleted = db.prepare("SELECT deletedAt FROM material_state WHERE id = ?").get(r.id)?.["deletedAt"];
      const owner = typeof r.fields["case"] === "string" ? caseNumberOf(db, r.fields["case"], reader) : "—";
      return message(deleted === null || deleted === undefined ? "material_label" : "material_deleted_label", { path, case: owner });
    }
    default:
      return r.id;
  }
}
