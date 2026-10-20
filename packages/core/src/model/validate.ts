// Нарушения правил модели данных — 400 model_invalid с details.issues: { field, rule, code }
// (contracts/http-api.md фичи 005; research R2). Тексты правил — locales/ru.json, model_issue_<rule>.
import { message, type MessageCode } from "@aristotel/protocol";
import { ApiError } from "../api/errors.ts";
import type { RecordContext } from "../bank/record-types.ts";
import type { AppliedDictionary, DictElement } from "../dictionary/current.ts";

export type IssueRule =
  | "required"
  | "closed"
  | "immutable"
  | "create_only"
  | "unknown"
  | "format"
  | "single_item"
  | "member"
  | "kind"
  | "status"
  | "deprecated"
  | "reason"
  | "ends"
  | "server"
  | "field"
  | "observer";

export interface Issue {
  field: string;
  rule: IssueRule;
  /** Машинный код нарушения — для тестов и интерфейса. */
  code: string;
}

export class Issues {
  readonly list: Issue[] = [];
  add(field: string, rule: IssueRule, code: string = rule): void {
    this.list.push({ field, rule, code });
  }
  throwIfAny(): void {
    if (this.list.length > 0) throw modelInvalid(this.list);
  }
}

export function modelInvalid(issues: Issue[]): ApiError {
  const detail = issues.map((i) => `${i.field}: ${message(`model_issue_${i.rule}` as MessageCode)}`).join("; ");
  return new ApiError("model_invalid", { detail }, { details: { issues } });
}

/** Словарь Сети применён — иначе Записей модели не заводят (409 dictionary_missing). */
export function requireDictionary(ctx: RecordContext): AppliedDictionary {
  if (ctx.dictionary === undefined) throw new ApiError("dictionary_missing");
  return ctx.dictionary;
}

/** Значение перечня по Идентификатору; не из этого перечня — undefined. */
export function enumValue(dict: AppliedDictionary, enumCode: string, id: unknown): DictElement | undefined {
  if (typeof id !== "string") return undefined;
  const en = dict.byCode("enum", enumCode);
  const el = dict.element(id);
  return en !== undefined && el !== undefined && el.kind === "enum_value" && el.props["enum"] === en.id ? el : undefined;
}

/** Тип Записи по Идентификатору; нет такой — undefined. */
export function recordTypeOf(ctx: RecordContext, id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const row = ctx.db.prepare("SELECT type FROM record WHERE id = ?").get(id);
  return row === undefined ? undefined : String(row["type"]);
}

export function recordFields(ctx: RecordContext, id: string): Record<string, unknown> | undefined {
  const row = ctx.db.prepare("SELECT fields FROM record WHERE id = ?").get(id);
  return row === undefined ? undefined : (JSON.parse(String(row["fields"])) as Record<string, unknown>);
}

/** Роль Члена Группы; нет такого — undefined. */
export function memberRole(ctx: RecordContext, id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const row = ctx.db.prepare("SELECT role FROM member WHERE id = ?").get(id);
  return row === undefined ? undefined : String(row["role"]);
}

/** Действующий Член Группы: отозванный — уже не исполнитель и не автор новой Записи (DATA-19, DATA-11; T252). */
export function isMember(ctx: RecordContext, id: unknown): boolean {
  return typeof id === "string" && ctx.db.prepare("SELECT 1 AS x FROM member WHERE id = ? AND state = 'active'").get(id) !== undefined;
}
