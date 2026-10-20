// Блокировка интерфейса по простою (STATION-11, contracts/lokalnaya-chast.md): локальная часть решает,
// заблокирован ли интерфейс; страница опрашивает её состояние — опрос простоем не считается — и скрывает
// содержимое, как только видит uiLocked, не дожидаясь действия человека.

/** Как часто страница спрашивает состояние локальной части. */
export const STATE_POLL_MS = 10_000;

export interface LockState {
  accepted: boolean;
  unlocked: boolean;
  uiLocked: boolean;
}

/** Опрашивать состояние; ошибка опроса — пропуск до следующего. Вернуть остановку. */
export function watchState<S extends LockState>(fetchState: () => Promise<S>, onState: (state: S) => void, everyMs = STATE_POLL_MS): () => void {
  const timer = setInterval(() => {
    fetchState().then(onState, () => undefined);
  }, everyMs);
  return () => clearInterval(timer);
}

/** Показывать данные Группы только при принятой, открытой и не заблокированной Станции. */
export function contentVisible(state: LockState | null): boolean {
  return state !== null && state.accepted && state.unlocked && !state.uiLocked;
}
