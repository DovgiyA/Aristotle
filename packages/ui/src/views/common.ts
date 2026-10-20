// Общие элементы видов: таблица, поле ввода, кнопка, форма, выбор, сообщение об ошибке (APP-27). Только разметка —
// поведение задаёт контейнер main.ts.
import type { ReactNode } from "react";
import { h } from "../h.ts";

export function Table(props: { columns: string[]; rows: ReactNode[][]; testId?: string }): ReactNode {
  return h(
    "table",
    { className: "grid", "data-view": props.testId },
    h("thead", null, h("tr", null, ...props.columns.map((c) => h("th", { key: c }, c)))),
    h("tbody", null, ...props.rows.map((row, i) => h("tr", { key: i }, ...row.map((cell, j) => h("td", { key: j }, cell))))),
  );
}

export function Field(props: {
  label: string;
  name: string;
  type?: string | undefined;
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  multiline?: boolean | undefined;
}): ReactNode {
  const input = props.multiline === true
    ? h("textarea", { name: props.name, value: props.value, onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value) })
    : h("input", { name: props.name, type: props.type ?? "text", value: props.value, onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value) });
  return h("label", { className: "field" }, h("span", null, props.label), input);
}

export function Button(props: { label: string; onClick?: (() => void) | undefined; kind?: "primary" | "danger" | undefined; name?: string | undefined }): ReactNode {
  return h("button", { type: "button", className: props.kind ?? "", "data-action": props.name, onClick: props.onClick }, props.label);
}

export function ErrorLine(props: { text: string | null }): ReactNode {
  return props.text === null ? null : h("p", { className: "error", role: "alert" }, props.text);
}

/** Форма без состояния: значения полей читаются при отправке (диалоги браузера не нужны). */
/** Выбранный файл — только чтение текста (без типов DOM: виды проверяет и корневой tsconfig). */
export interface PickedFile {
  text: () => Promise<string>;
}

export function Form(props: {
  name: string;
  submit: string;
  onSubmit?: ((values: Record<string, string>, files: Record<string, PickedFile>) => void) | undefined;
  children: ReactNode[];
}): ReactNode {
  return h(
    "form",
    {
      className: "inline",
      "data-form": props.name,
      onSubmit: (e: { preventDefault: () => void; currentTarget: { elements: ArrayLike<{ name?: string; value?: string; files?: ArrayLike<PickedFile> | null }> } }) => {
        e.preventDefault();
        const values: Record<string, string> = {};
        const files: Record<string, PickedFile> = {};
        for (const element of Array.from(e.currentTarget.elements)) {
          if (typeof element.name !== "string" || element.name === "") continue;
          const picked = element.files?.[0];
          if (picked !== undefined) files[element.name] = picked;
          else if (typeof element.value === "string") values[element.name] = element.value;
        }
        props.onSubmit?.(values, files);
      },
    },
    ...props.children,
    h("button", { type: "submit", className: "primary", "data-action": props.name }, props.submit),
  );
}

/** Выбор из списка: подпись — текст, значение — то, что уйдёт в запрос. */
export function Select(props: {
  label?: string | undefined;
  name: string;
  options: [value: string, label: string][];
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  action?: string | undefined;
}): ReactNode {
  const select = h(
    "select",
    {
      name: props.name,
      defaultValue: props.value,
      "data-action": props.action,
      onChange: props.onChange === undefined ? undefined : (e: { target: { value: string } }) => props.onChange?.(e.target.value),
    },
    ...props.options.map(([value, label]) => h("option", { key: value, value }, label)),
  );
  return props.label === undefined ? select : h("label", { className: "field" }, h("span", null, props.label), select);
}

/** Поле ввода без состояния — для Form. */
export function Input(props: { label: string; name: string; required?: boolean | undefined; type?: "text" | "password" | "file" | undefined }): ReactNode {
  return h("label", { className: "field" }, h("span", null, props.label), h("input", { name: props.name, type: props.type ?? "text", required: props.required === true }));
}
