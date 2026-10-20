// Скелет Отчёта Кейса (research R13 фичи 005; DATA-31 … DATA-34): общие разделы и разделы по Коду
// Класса Изделия; разделов «Индикаторы для сквозного анализа» и «Связь с другими изделиями» нет — их
// строит выдача. Класс, о котором программа не знает, получает только общие разделы. Тексты — данные
// спецификации (case-form.json). Разделы по Классу встают перед «Выводами».
import form from "./case-form.json" with { type: "json" };

export interface GeneralPartField {
  field: string;
  label: string;
  required: boolean;
  defaultSource: "auto" | "manual";
  code: string;
}

/** Общая часть Кейса — строки DATA-14 … DATA-19. */
export const GENERAL_PART: readonly GeneralPartField[] = form.general as GeneralPartField[];

export function reportSections(classCodes: readonly string[]): string[] {
  const common = form.reportCommon;
  const byClass = form.reportByClass as Record<string, string[]>;
  // Только собственные ключи: Класс с именем свойства прототипа — без своих разделов (T186).
  const extra = [...new Set(classCodes.flatMap((c) => (Object.hasOwn(byClass, c) ? byClass[c]! : [])))];
  const conclusions = common.length - 2;
  return [...common.slice(0, conclusions), ...extra, ...common.slice(conclusions)];
}

/** Разделы скелета, которых нет в markdown Отчёта заголовками «## …». */
export function missingSections(markdown: string, classCodes: readonly string[]): string[] {
  const headings = new Set(
    markdown
      .split("\n")
      .map((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1])
      .filter((x): x is string => x !== undefined),
  );
  return reportSections(classCodes).filter((s) => !headings.has(s));
}
