// Строки интерфейса — только из файла локализации, первый язык — русский (APP-09, конституция VIII).
import { message, type MessageCode } from "@aristotel/protocol/browser";

export type UiKey = Extract<MessageCode, `ui.${string}`>;

export function t(key: UiKey | MessageCode, params: Record<string, string | number> = {}): string {
  return message(key, params);
}
