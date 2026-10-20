// Счётчики Ретранслятора за сутки — только числа: без адресов, без времени соединений и без Кодов
// чужих Групп (RELAY-24; research R16 фичи 004). Пишутся в counters.json раз в минуту и при остановке.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CounterName = "logins" | "splices" | "refusals";

export class Counters {
  readonly #path: string;
  #day = new Date().toISOString().slice(0, 10);
  #values: Record<CounterName, number> = { logins: 0, splices: 0, refusals: 0 };
  #timer: NodeJS.Timeout | undefined;

  constructor(dir: string, everyMs = 60_000) {
    this.#path = join(dir, "counters.json");
    this.#timer = setInterval(() => this.flush(), everyMs);
    this.#timer.unref();
  }

  add(name: CounterName): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#values = { logins: 0, splices: 0, refusals: 0 };
    }
    this.#values[name] += 1;
  }

  flush(): void {
    const temp = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ day: this.#day, ...this.#values }) + "\n");
      renameSync(temp, this.#path);
    } catch {
      // Счётчики — не данные: каталог пропал или нет места — Ретранслятор работает дальше.
    }
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.flush();
  }
}
