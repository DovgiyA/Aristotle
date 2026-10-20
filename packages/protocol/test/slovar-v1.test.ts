// T006 — документ версии Словаря Сети `aristotel/slovar/v1` и файл списка Стоп-листа
// `aristotel/stop-list/v1` по contracts/slovar-v1.md (research R4 фичи 005; DICT-16, DICT-42).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_BYTES,
  REGISTRY_FORMAT,
  SLOVAR_FORMAT,
  SLOVAR_MAX_BODY_BYTES,
  STOP_LIST_FILE_FORMAT,
  SignedDocumentError,
  SlovarFormatError,
  bodySha256,
  parseSignedDocument,
  parseSlovarBody,
  parseStopListFile,
  signingMessage,
} from "../src/index.ts";

const ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function minimalBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    issuedAt: "2026-10-19T10:00:00.000Z",
    previousSha256: null,
    programRequirements: { normClasses: ["строка"], materialKinds: [] },
    elements: [
      { id: ID(1), code: "operator", label: "Оператор", kind: "object_type", state: "active", sinceVersion: 1, props: { role: "node" } },
      {
        id: ID(2),
        code: "username",
        label: "Учётная запись",
        kind: "indicator_type",
        state: "active",
        sinceVersion: 1,
        props: { object: ID(1), format: "строка:64", comparable: true, normClass: "строка", identifying: "loose", autoSecret: false },
      },
    ],
    templates: [],
    stopLists: [{ id: ID(3), code: "common_defaults", label: "Общие умолчания", source: "нет, правится вручную", builtAt: "2026-10-13", rows: [[ID(2), "value", "x", "пояснение"]] }],
    merges: [],
    ...over,
  };
}

test("тело версии по схеме разбирается", () => {
  const body = parseSlovarBody(JSON.stringify(minimalBody()));
  assert.equal(body.number, 1);
  assert.equal(body.elements.length, 2);
  assert.deepEqual(body.stopLists[0]?.rows[0], [ID(2), "value", "x", "пояснение"]);
});

test("previousSha256 — null только у версии 1", () => {
  assert.throws(() => parseSlovarBody(JSON.stringify(minimalBody({ number: 2 }))), SlovarFormatError);
  assert.throws(() => parseSlovarBody(JSON.stringify(minimalBody({ previousSha256: "a".repeat(64) }))), SlovarFormatError);
  parseSlovarBody(JSON.stringify(minimalBody({ number: 2, previousSha256: "a".repeat(64) })));
});

test("лишнее поле на любом уровне — отказ", () => {
  assert.throws(() => parseSlovarBody(JSON.stringify(minimalBody({ x: 1 }))), SlovarFormatError);
  const withProp = minimalBody();
  (withProp["elements"] as Record<string, unknown>[])[0] = { ...(withProp["elements"] as Record<string, unknown>[])[0], x: 1 };
  assert.throws(() => parseSlovarBody(JSON.stringify(withProp)), SlovarFormatError);
  const withPropsField = minimalBody();
  const el = (withPropsField["elements"] as { props: Record<string, unknown> }[])[1]!;
  el.props = { ...el.props, x: 1 };
  assert.throws(() => parseSlovarBody(JSON.stringify(withPropsField)), SlovarFormatError);
});

test("строка Стоп-листа: вид из трёх, пояснение непустое", () => {
  const bad = (row: unknown[]) => minimalBody({ stopLists: [{ id: ID(3), code: "x", label: "x", source: "x", builtAt: "2026-10-13", rows: [row] }] });
  assert.throws(() => parseSlovarBody(JSON.stringify(bad([ID(2), "regex", "x", "п"]))), SlovarFormatError);
  assert.throws(() => parseSlovarBody(JSON.stringify(bad([ID(2), "value", "x", ""]))), SlovarFormatError);
  for (const kind of ["value", "range", "pattern"]) parseSlovarBody(JSON.stringify(bad([ID(2), kind, "x", "п"])));
});

test("предел тела по формату: Словарь — 64 МиБ, Реестр — 1 МиБ", () => {
  assert.equal(SLOVAR_MAX_BODY_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_BODY_BYTES, 1024 * 1024);
  const doc = (format: string, size: number) => JSON.stringify({ format, body: "x".repeat(size), signatures: [] });
  parseSignedDocument(doc(SLOVAR_FORMAT, 2 * 1024 * 1024), SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES });
  assert.throws(() => parseSignedDocument(doc(SLOVAR_FORMAT, SLOVAR_MAX_BODY_BYTES + 1), SLOVAR_FORMAT, { maxBodyBytes: SLOVAR_MAX_BODY_BYTES }), SignedDocumentError);
  assert.throws(() => parseSignedDocument(doc(REGISTRY_FORMAT, 2 * 1024 * 1024), REGISTRY_FORMAT), SignedDocumentError);
});

test("подписываемое сообщение и тождество версии", () => {
  const body = JSON.stringify(minimalBody());
  const message = Buffer.from(signingMessage(SLOVAR_FORMAT, body));
  assert.deepEqual(message, Buffer.concat([Buffer.from("aristotel/slovar/v1"), Buffer.from([0]), Buffer.from(body, "utf8")]));
  assert.match(bodySha256(body), /^[0-9a-f]{64}$/);
});

test("файл списка Стоп-листа `aristotel/stop-list/v1`", () => {
  const file = {
    format: STOP_LIST_FILE_FORMAT,
    code: "px4_firmware",
    label: "Прошивки PX4",
    source: "выпуски PX4/PX4-Autopilot на GitHub",
    builtAt: "2026-10-13",
    rows: [{ type: "file_sha256", kind: "value", value: "a".repeat(64), note: "PX4 x · y" }],
  };
  assert.equal(parseStopListFile(JSON.stringify(file)).rows.length, 1);
  assert.throws(() => parseStopListFile(JSON.stringify({ ...file, format: "x" })), SlovarFormatError);
  assert.throws(() => parseStopListFile(JSON.stringify({ ...file, extra: 1 })), SlovarFormatError);
  assert.throws(() => parseStopListFile(JSON.stringify({ ...file, rows: [{ ...file.rows[0], note: "" }] })), SlovarFormatError);
});

test("T241, конституция VIII: причина «не по формату» — по-русски, без английского текста TypeBox", () => {
  const english = /\bmust\b|\bfewer\b|\bexpected\b|\bproperty\b|\bcharacters\b/i;
  const cases: (() => unknown)[] = [
    () => parseSlovarBody(JSON.stringify({ number: 1 })),
    () => parseStopListFile(JSON.stringify({ format: STOP_LIST_FILE_FORMAT, code: "x", label: "", source: "x", builtAt: "x", rows: [] })),
    () => parseStopListFile(JSON.stringify({ format: STOP_LIST_FILE_FORMAT, code: "x", label: "x", source: "x", builtAt: "x", rows: [], extra: 1 })),
  ];
  for (const run of cases) {
    try {
      run();
      assert.fail("должен быть отказ");
    } catch (error) {
      assert.ok(error instanceof SlovarFormatError, String(error));
      assert.doesNotMatch(error.message, english, error.message);
      assert.match(error.message, /[а-яё]/i);
    }
  }
});

test("T260, T264: Идентификаторы — UUIDv7, issuedAt — UTC ISO 8601, Коды внешних стандартов — по форме стандарта", () => {
  const base = minimalBody() as Record<string, unknown> & { elements: Record<string, unknown>[] };
  const bad = (change: (b: typeof base) => void) => {
    const b = structuredClone(base);
    change(b);
    return () => parseSlovarBody(JSON.stringify(b));
  };
  assert.throws(bad((b) => (b.elements[0]!["id"] = "x")), SlovarFormatError, "id не UUIDv7");
  assert.throws(bad((b) => (b["issuedAt"] = "вчера")), SlovarFormatError, "issuedAt");
  const country = { id: ID(901), code: "country", label: "country", kind: "enum", state: "active", sinceVersion: 1, props: { closed: false } };
  const value = (code: string) => ({ id: ID(902), code, label: code, kind: "enum_value", state: "active", sinceVersion: 1, props: { enum: ID(901) } });
  assert.throws(bad((b) => b.elements.push(country, value("Not.A-Country"))), SlovarFormatError, "country не ISO 3166-1");
  assert.doesNotThrow(bad((b) => b.elements.push(country, value("UA"))));
});

test("T268, T273, T274: Коды XKB с вариантом; пояснение — печатный знак; issuedAt — существующее время", () => {
  const base = minimalBody() as Record<string, unknown> & { elements: Record<string, unknown>[]; stopLists: { rows: unknown[][] }[] };
  const body = (change: (b: typeof base) => void) => {
    const b = structuredClone(base);
    change(b);
    return () => parseSlovarBody(JSON.stringify(b));
  };
  const keyboard = { id: ID(911), code: "keyboard", label: "keyboard", kind: "enum", state: "active", sinceVersion: 1, props: { closed: false } };
  const layout = (code: string, n: number) => ({ id: ID(912 + n), code, label: code, kind: "enum_value", state: "active", sinceVersion: 1, props: { enum: ID(911) } });
  assert.doesNotThrow(body((b) => b.elements.push(keyboard, layout("de(nodeadkeys)", 0), layout("us(alt-intl)", 1), layout("de(T3)", 2), layout("us", 3))));
  for (const note of ["\u0081", "​", "﻿⁠"]) assert.throws(body((b) => (b.stopLists[0]!.rows[0]![3] = note)), SlovarFormatError, JSON.stringify(note));
  assert.throws(body((b) => (b["issuedAt"] = "2026-13-45T99:99:99Z")), SlovarFormatError);
});

test("T281: «печатный знак» — не невидимый форматирующий (Cf) и не знак-заполнитель", () => {
  const body = minimalBody() as Record<string, unknown> & { stopLists: { rows: unknown[][] }[] };
  for (const note of ["؜", "᠎", "￹", "\u{e0001}", "\u{1d173}", "ㅤ"]) {
    const b = structuredClone(body);
    b.stopLists[0]!.rows[0]![3] = note;
    assert.throws(() => parseSlovarBody(JSON.stringify(b)), SlovarFormatError, JSON.stringify(note));
  }
});

test("T285: «печатный знак» — не Default_Ignorable (селекторы вариантов и подобные)", () => {
  const body = minimalBody() as Record<string, unknown> & { stopLists: { rows: unknown[][] }[] };
  for (const note of ["️", "͏", "᠋", "឴", "\u{e0100}"]) {
    const b = structuredClone(body);
    b.stopLists[0]!.rows[0]![3] = note;
    assert.throws(() => parseSlovarBody(JSON.stringify(b)), SlovarFormatError, JSON.stringify(note));
  }
});
