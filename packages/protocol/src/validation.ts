// Ошибки проверки схем по-русски: AJV (Fastify) и TypeBox отдают одинаковые записи
// { keyword, instancePath, params }; английский message библиотек людям не показывается
// (конституция VIII, APP-09).
import { message, type MessageCode } from "./messages.ts";

export interface SchemaIssue {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
}

/** Где проверялись данные — для подписи, когда ошибка относится ко всему объекту. */
export type IssueScope = "body" | "querystring" | "params" | "fields";

const WHOLE: Record<IssueScope, MessageCode> = {
  body: "field_whole_body",
  querystring: "field_whole_query",
  params: "field_whole_params",
  fields: "field_whole_fields",
};

const TYPES: Record<string, MessageCode> = {
  string: "type_string",
  integer: "type_integer",
  number: "type_number",
  object: "type_object",
  array: "type_array",
  boolean: "type_boolean",
  null: "type_null",
};

function fieldName(path: string, scope: IssueScope): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length === 0 ? message(WHOLE[scope]) : parts.join(".");
}

function child(path: string, name: unknown, scope: IssueScope): string {
  return fieldName(`${path}/${String(name)}`, scope);
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** Описание первой содержательной ошибки схемы по-русски. */
export function describeIssues(issues: readonly SchemaIssue[], scope: IssueScope): string {
  // TypeBox перед additionalProperties отдаёт «schema is false» (keyword boolean) для того же поля.
  const issue = issues.find((i) => i.keyword !== "boolean") ?? issues[0];
  if (issue === undefined) return message("validation_other", { field: message(WHOLE[scope]) });
  const field = fieldName(issue.instancePath, scope);
  const limit = String(issue.params["limit"] ?? "");
  switch (issue.keyword) {
    case "type": {
      const type = String(firstOf(issue.params["type"]));
      return message("validation_type", { field, type: TYPES[type] === undefined ? type : message(TYPES[type]) });
    }
    case "minLength":
      return message("validation_min_length", { field, limit });
    case "maxLength":
      return message("validation_max_length", { field, limit });
    case "minimum":
      return message("validation_minimum", { field, limit });
    case "maximum":
      return message("validation_maximum", { field, limit });
    case "required": {
      const missing = issue.params["missingProperty"] ?? firstOf(issue.params["requiredProperties"]);
      return message("validation_required", { field: child(issue.instancePath, missing, scope) });
    }
    case "additionalProperties": {
      const extra = issue.params["additionalProperty"] ?? firstOf(issue.params["additionalProperties"]);
      return message("validation_additional", { field: child(issue.instancePath, extra, scope) });
    }
    case "boolean":
      return message("validation_additional", { field });
    default:
      return message("validation_other", { field });
  }
}
