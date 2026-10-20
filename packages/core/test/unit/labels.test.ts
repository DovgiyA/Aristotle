// T042 (часть «Кейс») — подписи (BANK-31, BANK-32; research R14 фичи 005): свой Кейс — ГГГГ-NNN,
// чужой — <Код Группы>·ГГГГ-NNN; Номер ссылкой не служит.
import { test } from "node:test";
import assert from "node:assert/strict";
import { caseLabel } from "../../src/model/labels.ts";

test("свой Кейс — Номер; чужой — Код Группы и «·» U+00B7", () => {
  assert.equal(caseLabel("2026-014", undefined, "A"), "2026-014");
  assert.equal(caseLabel("2026-014", "A", "A"), "2026-014");
  assert.equal(caseLabel("2026-014", "B", "A"), "B·2026-014");
});

// T049 (часть «Объекты») — BANK-35: объект — по первому видимому опознающему Индикатору, без него —
// «Подпись типа · — · Номер Кейса»; связь — через концы; Индикатор — через объект.
import { startTestService } from "../../../../tests/support/harness.ts";
import { applyTestDictionary, createTestCase, createTestItem, createTestObject, postIndicator, T } from "../../../../tests/support/dictionary.ts";
import { callAs } from "../../../../tests/support/harness.ts";
import { currentDictionary } from "../../src/dictionary/current.ts";
import { recordLabel } from "../../src/model/labels.ts";

test("подписи объекта, связи и Индикатора; Наблюдателю — без Секрет-Индикатора", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const dict = currentDictionary(svc.db);
  assert.equal(recordLabel(svc.db, dict, op.id), `Оператор · — · ${c.fields["number"]}`);
  const secretName = (await postIndicator(svc, u1, op.id, "username", { value: "x" })).json();
  await callAs(svc, u1, "POST", `/api/records/${secretName.id}/secret/mark`, { expectedVersion: 1 });
  await postIndicator(svc, u1, op.id, "callsign", { value: "y" });
  assert.equal(recordLabel(svc.db, dict, op.id), "x");
  assert.equal(recordLabel(svc.db, dict, op.id, { role: "observer" }), "y", "Секрет-Индикатор Наблюдателю в подпись не идёт");
  const link = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: item.id, to: op.id, confidence: "high", source: { kind: "manual" } } })).json();
  assert.equal(recordLabel(svc.db, dict, link.id), `companion-компьютер · ${c.fields["number"]} — авторства → x`);
  const ind = (await postIndicator(svc, u1, op.id, "callsign", { value: "z" })).json();
  assert.equal(recordLabel(svc.db, dict, ind.id), "Позывной: z (x)");
});

test("T081, VIEW-16: Наблюдатель не видит подписи Секрет-объекта через связь и Индикатор", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const h1 = svc.addMember("Н1", "observer");
  const c = await createTestCase(svc, u1);
  const item = await createTestItem(svc, u1, c.id);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  await postIndicator(svc, u1, op.id, "username", { value: "x" });
  const link = (await callAs(svc, u1, "POST", "/api/records", { type: "link", fields: { type: T.link("authored_by"), from: item.id, to: op.id, confidence: "high", source: { kind: "manual" } } })).json();
  const ind = (await postIndicator(svc, u1, op.id, "callsign", { value: "y" })).json();
  assert.equal((await callAs(svc, u1, "POST", `/api/records/${op.id}/secret/mark`, { expectedVersion: 1 })).statusCode, 200);
  assert.equal((await callAs(svc, h1, "GET", `/api/records/${op.id}`)).statusCode, 404);
  const linkView = (await callAs(svc, h1, "GET", `/api/records/${link.id}`)).json().view.label as string;
  assert.doesNotMatch(linkView, /\bx\b/);
  assert.match(linkView, /авторства → —$/);
  assert.doesNotMatch((await callAs(svc, h1, "GET", `/api/records/${ind.id}`)).json().view.label, /\bx\b/);
  // Участник видит Секрет — подпись прежняя.
  assert.match((await callAs(svc, u1, "GET", `/api/records/${link.id}`)).json().view.label, /авторства → x$/);
});

test("T198, DICT-12: подпись объекта поглощённого вида — по опознающим типам канонического вида", async (t) => {
  const { callMaintenance } = await import("../../../../tests/support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../../../tests/support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const radio = await createTestObject(svc, u1, "radio", { case: c.id });
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.object("radio"))!;
      el.state = "absorbed";
      el.canonical = T.object("infra_node");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  assert.equal((await postIndicator(svc, u1, radio.id, "domain", { value: "node.example.org" })).statusCode, 201);
  assert.equal(recordLabel(svc.db, currentDictionary(svc.db), radio.id), "node.example.org");
});

test("T110, DICT-40: значение со Стоп-листа подписью объекта не служит — оно не опознаёт", async (t) => {
  const svc = await startTestService(t);
  await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  await postIndicator(svc, u1, op.id, "username", { value: "V" });
  const dict = currentDictionary(svc.db);
  assert.equal(recordLabel(svc.db, dict, op.id), `Оператор · — · ${c.fields["number"]}`, "«v» — в Стоп-листе стенда");
  await postIndicator(svc, u1, op.id, "callsign", { value: "y" });
  assert.equal(recordLabel(svc.db, dict, op.id), "y");
});

test("T236, DICT-12: подпись Индикатора поглощённого типа — по Подписи канона", async (t) => {
  const { callMaintenance } = await import("../../../../tests/support/harness.ts");
  const { nextTestVersion, signWithTestCoordinator } = await import("../../../../tests/support/dictionary.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const c = await createTestCase(svc, u1);
  const op = await createTestObject(svc, u1, "operator", { case: c.id });
  const ind = (await postIndicator(svc, u1, op.id, "callsign", { value: "Eagle" })).json();
  const v2 = signWithTestCoordinator(
    nextTestVersion(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.indicator("callsign"))!;
      el.state = "absorbed";
      el.canonical = T.indicator("username");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
    }),
  );
  assert.equal((await callMaintenance(svc, "POST", "/api/dictionary/versions", v2)).statusCode, 201);
  assert.equal(recordLabel(svc.db, currentDictionary(svc.db), ind.id), "Учётная запись: Eagle (Eagle)");
});
