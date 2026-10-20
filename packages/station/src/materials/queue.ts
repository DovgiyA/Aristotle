// Очередь доставки файлов Материалов (BANK-18, BANK-19, STATION-07; research R6 фичи 006;
// contracts/lokalnaya-chast.md «Очередь доставки»): materials/queue.json переживает перезапуск;
// смещение — у Опорной станции: после обрыва, смены Прохода или перезапуска Станция спрашивает его и
// продолжает с него частями по MATERIAL_PART_BYTES. Испорченная копия (хэш не сошёлся) — rejected без
// повторов: правильный файл доставит другая допустимая Станция (FR-008a).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MATERIAL_OFFSET_HEADER, MATERIAL_PART_BYTES } from "@aristotel/protocol";
import { StationDeletedError, StationLockedError, type LocalPart } from "../local-part.ts";
import { materialCopyPath, materialsDir } from "./store.ts";

export type QueueState = "waiting" | "sending" | "done" | "rejected";

export interface QueueItem {
  id: string;
  size: number;
  received: number;
  state: QueueState;
  error: string | null;
  /** Не раньше этого времени (мс): «держит другая Станция» до until (T091), пауза после 5xx (T095). */
  notBefore?: number | null;
  /** Подряд временных ошибок Опорной станции — пауза растёт вдвое (T095). */
  attempts?: number;
}

/** Отказы, после которых повтор отправил бы то же самое (T082). */
const TERMINAL = new Set(["delivery_hash_mismatch", "delivery_station", "material_deleted", "not_found", "forbidden", "material_copy_missing"]);
/** Не дольше этого ждать между проверками при отложенных Материалах; «держит другая Станция» — тоже
 * проверяется не реже: держателя могли отозвать, и тогда Опорная станция примет доставку сразу (T097). */
const MAX_WAIT_MS = 60_000;
/** Предел паузы после временных ошибок Опорной станции (T095). */
const MAX_BACKOFF_MS = 5 * 60_000;

export interface QueueOptions {
  /** Пауза перед повтором после обрыва или отказа «держит другая Станция», мс. */
  retryMs?: number;
  /** Не дольше этого ждать отложенный Материал до новой проверки, мс (по умолчанию 60 с; стенд — меньше). */
  maxWaitMs?: number;
}

export class DeliveryQueue {
  readonly #part: LocalPart;
  readonly #file: string;
  readonly #retryMs: number;
  readonly #maxWaitMs: number;
  #items: QueueItem[];
  #wake: (() => void) | undefined;
  #stopped = false;
  #running: Promise<void> | undefined;
  #adopting: Promise<void> | undefined;

  constructor(part: LocalPart, options: QueueOptions = {}) {
    this.#part = part;
    this.#file = join(materialsDir(part.dataDir), "queue.json");
    this.#retryMs = options.retryMs ?? 2000;
    this.#maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    this.#items = existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as { items: QueueItem[] }).items : [];
    for (const item of this.#items) if (item.state === "sending") item.state = "waiting";
  }

  list(): QueueItem[] {
    return this.#items.map((i) => ({ ...i }));
  }

  has(id: string): boolean {
    return this.#items.some((i) => i.id === id);
  }

  /** В очередь; reset — новая копия того же Материала (доставка с другой Станции, T078). */
  enqueue(id: string, size: number, options: { reset?: boolean } = {}): void {
    const item = this.#items.find((i) => i.id === id);
    if (item === undefined) this.#items.push({ id, size, received: 0, state: "waiting", error: null });
    else if (options.reset === true) Object.assign(item, { size, state: "waiting", error: null });
    this.#save();
    this.kick();
  }

  /**
   * Начать или продолжить доставку сейчас — после смены связи или открытия Ключа станции. Отклонённое
   * (испорченная или пропавшая копия, чужой Материал) не повторяется: повтор отправил бы то же (T082).
   */
  kick(id?: string): void {
    if (id !== undefined) {
      const item = this.#items.find((i) => i.id === id);
      if (item !== undefined && item.state === "sending") item.state = "waiting";
      if (item !== undefined) item.notBefore = null;
      this.#save();
    }
    this.#wake?.();
    this.#running ??= this.#loop().finally(() => (this.#running = undefined));
  }

  /**
   * Подобрать копии, которых нет в очереди, но у Опорной станции есть их Запись «не доставлен»: ответ
   * 201 потерян или сбой между Записью и очередью (T079). Без связи — ничего: Материал ждёт офлайн-
   * черновика (фича 009).
   */
  async adopt(): Promise<void> {
    this.#adopting ??= this.#adopt().finally(() => (this.#adopting = undefined));
    await this.#adopting;
  }

  async #adopt(): Promise<void> {
    const dir = materialsDir(this.#part.dataDir);
    if (!existsSync(dir)) return;
    const ids = readdirSync(dir).filter((name) => /^[0-9a-f-]{36}$/.test(name) && existsSync(join(dir, `${name}.zaverenie.json`)) && !this.has(name));
    for (const id of ids) {
      try {
        const res = await this.#part.request("GET", `/api/materials/${encodeURIComponent(id)}`);
        if (res.status !== 200) continue;
        const record = res.json() as { fields: { size?: string }; view?: { delivery?: string } };
        if (record.view?.delivery !== "pending") continue;
        this.#items.push({ id, size: Number(record.fields.size ?? 0), received: 0, state: "waiting", error: null });
      } catch {
        return; // нет связи — подберём при следующем открытии
      }
    }
    this.#save();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    await this.#running;
  }

  /** Дождаться, пока в очереди не останется недоставленного (для CLI --wait и тестов). */
  async idle(timeoutMs = 60_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.#items.some((i) => i.state === "waiting" || i.state === "sending") && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }

  #save(): void {
    mkdirSync(materialsDir(this.#part.dataDir), { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ items: this.#items }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.#file);
  }

  async #pause(ms = this.#retryMs): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.#wake = undefined;
  }

  async #loop(): Promise<void> {
    let failedInRow = 0;
    while (!this.#stopped) {
      const active = (i: QueueItem) => i.state === "waiting" || i.state === "sending";
      const now = Date.now();
      const item = this.#items.find((i) => active(i) && (i.notBefore ?? 0) <= now);
      if (item === undefined) {
        const waiting = this.#items.filter(active).map((i) => i.notBefore ?? now);
        if (waiting.length === 0) return;
        // Все отложены (держит другая Станция): ждать до ближайшего срока, не дёргая Опорную станцию.
        await this.#pause(Math.min(Math.max(Math.min(...waiting) - now, 50), this.#maxWaitMs));
        continue;
      }
      if (!this.#part.unlocked) return; // откроют Ключ станции — kick
      let again: boolean;
      try {
        again = await this.#deliver(item);
      } catch (error) {
        if (error instanceof StationLockedError || error instanceof StationDeletedError) return;
        if ((error as { code?: string }).code === "ENOENT") {
          // Копии на Станции нет — повтор бесполезен (T080).
          item.state = "rejected";
          item.error = "material_copy_missing";
          again = false;
        } else {
          again = true; // обрыв, нет Прохода — повтор с принятого смещения
        }
      }
      if (again) {
        // В конец очереди: «держит другая Станция» или нет места у одного Материала не задерживает
        // остальные (T080); пауза — только когда ждать больше нечего.
        this.#items.splice(this.#items.indexOf(item), 1);
        this.#items.push(item);
      }
      this.#save();
      failedInRow = again ? failedInRow + 1 : 0;
      const activeCount = this.#items.filter(active).length;
      if (again && failedInRow >= activeCount) {
        failedInRow = 0;
        await this.#pause();
      }
    }
  }

  /** Доставить один Материал; true — повторить позже, false — с ним всё решено. */
  async #deliver(item: QueueItem): Promise<boolean> {
    item.state = "sending";
    const res = await this.#part.request("GET", `/api/materials/${encodeURIComponent(item.id)}/content/offset`);
    if (res.status !== 200) return this.#refused(item, res.status, bodyOf(res.text));
    item.received = Number(res.json()["received"]);
    const path = materialCopyPath(this.#part.dataDir, item.id);
    const fd = openSync(path, "r");
    try {
      while (!this.#stopped) {
        const length = Math.min(MATERIAL_PART_BYTES, item.size - item.received);
        const chunk = Buffer.alloc(Math.max(length, 0));
        if (length > 0) readSync(fd, chunk, 0, length, item.received);
        const put = await this.#part.requestBinary("PUT", `/api/materials/${encodeURIComponent(item.id)}/content`, chunk, { [MATERIAL_OFFSET_HEADER]: String(item.received) });
        const body = bodyOf(put.text);
        if (put.status !== 200) return this.#refused(item, put.status, body);
        item.received = Number(body["received"] ?? item.received + length);
        item.attempts = 0;
        this.#save();
        if (item.received >= item.size) {
          item.state = "done";
          item.error = null;
          return false;
        }
      }
      return true;
    } finally {
      closeSync(fd);
    }
  }

  #refused(item: QueueItem, status: number, body: Record<string, unknown>): boolean {
    const error = String(body["error"] ?? "internal_error");
    if (error === "delivery_done") {
      item.state = "done";
      item.error = null;
      return false;
    }
    if (error === "delivery_offset") {
      item.received = Number(body["received"] ?? 0);
      item.state = "waiting";
      return false; // сразу с принятого
    }
    if (error === "delivery_held") {
      const until = Date.parse(String(body["until"] ?? ""));
      item.notBefore = Math.min(Number.isFinite(until) ? until : Date.now() + this.#retryMs, Date.now() + this.#maxWaitMs);
      item.state = "waiting";
      item.error = error;
      return true;
    }
    if (TERMINAL.has(error) || (status >= 400 && status < 500 && !["delivery_no_space", "offline", "session_required"].includes(error))) {
      // Испорченная копия, чужой или удалённый Материал — повтор бесполезен.
      item.state = "rejected";
      item.error = error;
      return false;
    }
    // Нет места, нет связи, временные ошибки Опорной станции (5xx) — повторить позже (T092) с
    // нарастающей паузой: стойкая ошибка не заставляет Опорную станцию перечитывать образ раз в 2 с (T095).
    item.attempts = (item.attempts ?? 0) + 1;
    item.notBefore = Date.now() + Math.min(this.#retryMs * 2 ** (item.attempts - 1), MAX_BACKOFF_MS);
    item.state = "waiting";
    item.error = error;
    return true;
  }
}

function bodyOf(text: string): Record<string, unknown> {
  try {
    const value: unknown = text === "" ? {} : JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
