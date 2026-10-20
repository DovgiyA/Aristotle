// События Сети внутри процесса службы: применена версия Реестра или Словаря Сети — клиент Ретрансляторов и события
// Станций пересматривают Проходы (STATION-05, STATION-42; research R5, R13 фичи 004).
import { EventEmitter } from "node:events";

export interface NetworkEventMap {
  "registry-applied": [number: number];
  "passage-list-changed": [];
  /** Применена версия Словаря Сети (DICT-18): фоновый поиск дублей (фича 012) и Пересверка (фича 021). */
  "dictionary-applied": [number: number];
}

export const networkEvents = new EventEmitter<NetworkEventMap>();
networkEvents.setMaxListeners(100);
