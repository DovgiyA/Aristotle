// Сообщения людям из API и CLI берутся только из файла локализации (APP-09, конституция VIII).
import ru from "../../../locales/ru.json" with { type: "json" };

export type MessageCode = keyof typeof ru;

/** Есть ли такой код в файле локализации. */
export function isMessageCode(code: string): code is MessageCode {
  return Object.hasOwn(ru, code);
}

/** Текст сообщения на русском с подстановкой параметров вида {name}. */
export function message(code: MessageCode, params: Record<string, string | number> = {}): string {
  return ru[code].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
