// Местное расширение Группы (research R10 фичи 005; DICT-03, DICT-05, DICT-07, DICT-08, DICT-45,
// DICT-56, DICT-61; Clarifications фичи 005): предложения пяти видов и допустимые ужесточения правил Сети.
import { Type, type Static } from "typebox";
import { PRINTABLE_TEXT } from "./slovar.ts";

const Strict = { additionalProperties: false } as const;
const SnakeCode = Type.String({ pattern: "^[a-z][a-z0-9_]*$", maxLength: 56 });
/**
 * Пояснение и причина: хотя бы один печатный символ и ни одного NUL — SQLite length() обрывается на
 * NUL, и ограничение БД «непустой текст» иначе срабатывает 500-й ошибкой (DICT-45; T177).
 */
const TEXT_PATTERN = PRINTABLE_TEXT;

/** Подпись и значение строки — хотя бы один печатный символ (DATA-26, DICT-09; T221). */
const PrintableLabel = Type.String({ minLength: 1, maxLength: 200, pattern: TEXT_PATTERN });
/**
 * Код местного значения перечня: snake_case, а у перечней по внешним стандартам (`timezone`, `country`,
 * `keyboard`) — идентификатор стандарта, как в версии Сети (DICT-63; T209); какой из двух — решает служба
 * по перечню.
 */
const ValueCode = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_/+.()-]*$", maxLength: 64 });

export const LOCAL_PROPOSAL_KINDS = ["type", "enum_value", "template_field", "stop_list_entry", "override"] as const;
export type LocalProposalKind = (typeof LOCAL_PROPOSAL_KINDS)[number];

export const LocalPayloads = {
  /** Местный тип Индикатора; Код — без префикса, служба добавит «<Код Группы>:» (DICT-61). */
  type: Type.Object(
    {
      code: SnakeCode,
      label: PrintableLabel,
      object: Type.String({ minLength: 1 }),
      format: Type.String({ minLength: 1 }),
      normClass: Type.Optional(Type.String()),
      autoSecret: Type.Optional(Type.Boolean()),
    },
    Strict,
  ),
  /** Значение открытого перечня (DICT-14); закрытые перечни местно не дополняются (DICT-60). */
  enum_value: Type.Object({ enum: Type.String({ minLength: 1 }), code: ValueCode, label: PrintableLabel }, Strict),
  /** Необязательное поле шаблона местного типа (DICT-08); подтип — у шаблона Класса с подтипом (T210). */
  template_field: Type.Object(
    {
      class: Type.String({ minLength: 1 }),
      subtype: Type.Optional(SnakeCode),
      block: Type.Union([Type.Literal("header"), Type.Literal("media"), Type.Literal("os"), Type.Literal("class")]),
      label: PrintableLabel,
      indicatorType: Type.String({ minLength: 1 }),
    },
    Strict,
  ),
  /**
   * Строка списка «Местное»: новая — пояснение обязательно (DICT-45); удаление прежней — { remove:
   * Идентификатор строки }. Напрямую список не правится (Clarifications фичи 005).
   */
  stop_list_entry: Type.Union([
    Type.Object(
      {
        type: Type.String({ minLength: 1 }),
        kind: Type.Union([Type.Literal("value"), Type.Literal("range"), Type.Literal("pattern")]),
        value: Type.String({ minLength: 1, pattern: TEXT_PATTERN }),
        note: Type.String({ minLength: 1, pattern: TEXT_PATTERN }),
      },
      Strict,
    ),
    Type.Object({ remove: Type.String({ minLength: 1 }) }, Strict),
  ]),
  /** Изменение правила Сети — только ужесточение (DICT-07, DICT-56). */
  override: Type.Object({ element: Type.String({ minLength: 1 }), property: Type.String({ minLength: 1 }), value: Type.Unknown() }, Strict),
} as const;

export const LocalProposalRequest = Type.Object(
  { kind: Type.Union(LOCAL_PROPOSAL_KINDS.map((k) => Type.Literal(k))), payload: Type.Record(Type.String(), Type.Unknown()) },
  Strict,
);
export type LocalProposalRequest = Static<typeof LocalProposalRequest>;

export const LocalRejectRequest = Type.Object({ reason: Type.String({ minLength: 1, pattern: TEXT_PATTERN }) }, Strict);

/**
 * Допустимые ужесточения (DICT-07): строгий → нестрогий опознающий, автоматический Секрет — включить.
 * Всё прочее — снять Секрет, сопоставляемость, строгость, Класс нормализации, неопознающий, отключить
 * сравнение между типами — ослабление (422 local_weakening).
 */
export function isTightening(property: string, value: unknown, current: { identifying?: unknown; autoSecret?: unknown }): boolean {
  // Уже нестрогий тип (Сетью или прежним ужесточением) — то же правило, принимается без изменений (T230).
  if (property === "identifying") return value === "loose" && (current.identifying === "strict" || current.identifying === "loose");
  if (property === "autoSecret") return value === true;
  return false;
}

export interface LocalProposalView {
  id: string;
  kind: LocalProposalKind;
  payload: Record<string, unknown>;
  state: "proposed" | "accepted" | "rejected";
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  resultId: string | null;
}
