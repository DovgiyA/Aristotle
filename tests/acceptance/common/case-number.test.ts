// T040 — Номер Кейса (SC-004; BANK-26 … BANK-30, BANK-36 как граница; research R3 фичи 005): вид
// ГГГГ-NNN без префикса CASE-, год выдачи по UTC, порядок выдачи, без повторов при одновременных
// созданиях и сбоях, Номер Отклонённого Кейса занят навсегда, продолжение с заданного Номера.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAs, startTestService } from "../../support/harness.ts";
import { EV, applyTestDictionary, createTestCase } from "../../support/dictionary.ts";
import { advanceCaseCounter, bindCaseNumber, issueCaseNumber } from "@aristotel/core";

const YEAR = new Date().getUTCFullYear();

test("Номер ГГГГ-NNN: год выдачи, три цифры, без префикса; по порядку выдачи", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const a = await createTestCase(svc, u1);
  const b = await createTestCase(svc, u1);
  assert.equal(a.fields["number"], `${YEAR}-001`);
  assert.equal(b.fields["number"], `${YEAR}-002`);
  assert.doesNotMatch(String(a.fields["number"]), /CASE/);
});

test("1 000 одновременных созданий — 1 000 разных Номеров подряд", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const results = await Promise.all(Array.from({ length: 1000 }, () => createTestCase(svc, u1)));
  const numbers = results.map((r) => String(r.fields["number"])).sort((x, y) => Number(x.split("-")[1]) - Number(y.split("-")[1]));
  assert.equal(new Set(numbers).size, 1000);
  assert.equal(numbers[0], `${YEAR}-001`);
  assert.equal(numbers.at(-1), `${YEAR}-1000`, "после 999 — четыре цифры без смены вида меньших");
});

test("сбой в транзакции создания не оставляет ни Кейса, ни Номера; Номер Отклонённого Кейса занят", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const first = await createTestCase(svc, u1);
  // Сбой — неизвестный исполнитель: prepare уже выдал Номер, транзакция откатывается целиком.
  const bad = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: EV("case_shape", "single_item"), performers: ["x"] } });
  assert.equal(bad.statusCode, 400);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM case_number").get()?.["n"], 1);
  // Отклонение — фича 010; статус выставляется в БД тестом.
  const rejected = { ...first.fields, status: "rejected" };
  svc.db.prepare("UPDATE record SET fields = ? WHERE id = ?").run(JSON.stringify(rejected), first.id);
  const next = await createTestCase(svc, u1);
  assert.equal(next.fields["number"], `${YEAR}-002`, "Номер отклонённого не выдаётся снова (BANK-30)");
});

test("смена года — счётчик нового года с 001; продолжение с заданного Номера; назад — отказ", async (t) => {
  const svc = await startTestService(t);
  assert.equal(issueCaseNumber(svc.db, "2026-12-31T23:59:59.000Z", "c-a"), "2026-001");
  assert.equal(issueCaseNumber(svc.db, "2027-01-01T00:00:00.000Z", "c-b"), "2027-001");
  advanceCaseCounter(svc.db, 2026, 25);
  assert.equal(issueCaseNumber(svc.db, "2026-06-01T00:00:00.000Z", "c-c"), "2026-025");
  assert.throws(() => advanceCaseCounter(svc.db, 2026, 10));
  assert.throws(() => advanceCaseCounter(svc.db, 2026, 25), "равный выданному — отказ");
});

test("number в запросе создания или правки — 400 model_invalid", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const bad = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { number: "2026-777", shape: EV("case_shape", "single_item") } });
  assert.deepEqual([bad.statusCode, bad.json().error], [400, "model_invalid"]);
  const c = await createTestCase(svc, u1);
  const patch = await callAs(svc, u1, "PATCH", `/api/records/${c.id}`, { expectedVersion: c.version, fields: { number: "2026-777" } });
  assert.deepEqual([patch.statusCode, patch.json().error], [400, "model_invalid"]);
});

test("T119: сбой после выдачи Номера откатывает и счётчик, и case_number; следующий Кейс получает тот же Номер", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  // Лишнее поле отклоняет checkFields уже после prepare, то есть после выдачи Номера (research R3).
  const bad = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: { shape: EV("case_shape", "single_item"), seizedBy: "x" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM case_number").get()?.["n"], 0);
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM case_number_counter").get()?.["n"], 0, "счётчик не сдвинут");
  assert.equal((await createTestCase(svc, u1)).fields["number"], `${YEAR}-001`);
});

test("T101: счётчик сверяется с выданными Номерами — Номер не больше занятого не выдаётся и не закрепляется (BANK-30, BANK-36)", async (t) => {
  const svc = await startTestService(t);
  // Номер занят без строки счётчика: перенос или восстановление (фичи 015, 017) расходятся со счётчиком.
  svc.db.prepare("INSERT INTO case_number (number, caseId, year, seq) VALUES ('2026-003', 'ext', 2026, 3)").run();
  assert.throws(() => issueCaseNumber(svc.db, "2026-06-01T00:00:00.000Z", "c-a"), "2026-001 не больше занятого 2026-003");
  assert.throws(() => advanceCaseCounter(svc.db, 2026, 3), "продолжение с занятого — отказ");
  advanceCaseCounter(svc.db, 2026, 4);
  assert.equal(issueCaseNumber(svc.db, "2026-06-01T00:00:00.000Z", "c-b"), "2026-004");
  // Закрепление занятого Номера за другим Кейсом — ошибка, а не тихий пропуск.
  assert.throws(() => bindCaseNumber(svc.db, "2026-004", "c-other"));
});

test("T129: счётчик отстал от занятых Номеров — создание Кейса отвечает 409 case_counter_behind, а не 500", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  svc.db.prepare("INSERT INTO case_number (number, caseId, year, seq) VALUES (?, 'ext', ?, 5)").run(`${YEAR}-005`, YEAR);
  const res = await callAs(svc, u1, "POST", "/api/records", { type: "case", fields: {} });
  assert.deepEqual([res.statusCode, res.json().error], [409, "case_counter_behind"]);
  advanceCaseCounter(svc.db, YEAR, 6);
  assert.equal((await createTestCase(svc, u1)).fields["number"], `${YEAR}-006`);
});
