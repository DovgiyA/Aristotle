// Блокировка интерфейса по простою (STATION-11): состояние локальной части опрашивается, и как только
// она сообщает uiLocked, содержимое скрывается без действия человека.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STATE_POLL_MS, contentVisible, watchState } from "../src/model/lock.ts";

test("опрос состояния: блокировка видна не позже чем через STATE_POLL_MS; остановка — без опросов", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let locked = false;
  const seen: boolean[] = [];
  const stop = watchState(async () => ({ accepted: true, unlocked: true, uiLocked: locked }), (s) => void seen.push(s.uiLocked));
  locked = true;
  t.mock.timers.tick(STATE_POLL_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [true]);
  stop();
  t.mock.timers.tick(STATE_POLL_MS * 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.ok(STATE_POLL_MS <= 15_000);
});

test("содержимое видно только при принятой, открытой и не заблокированной Станции", () => {
  assert.equal(contentVisible({ accepted: true, unlocked: true, uiLocked: false }), true);
  assert.equal(contentVisible({ accepted: true, unlocked: true, uiLocked: true }), false);
  assert.equal(contentVisible({ accepted: true, unlocked: false, uiLocked: false }), false);
  assert.equal(contentVisible(null), false);
});
