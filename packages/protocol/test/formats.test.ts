// T004 — форматы значений §5 приложения «Словарь Сети v1» (research R8 фичи 005; DICT-14, DICT-60,
// DATA-26). Нарушение формата — пометка `format_violation`, значение вне открытого перечня —
// `out_of_dictionary`, вне закрытого — `closed_violation`; пустое — не значение.
import { test } from "node:test";
import assert from "node:assert/strict";
import { domainToASCII } from "node:url";
import { FormatSpecError, checkFormat, parseFormat, type FormatContext } from "../src/index.ts";

const ctx: FormatContext = {
  toAscii: domainToASCII,
  enumCodes: (code) =>
    code === "os_distro"
      ? new Set(["debian", "ubuntu"])
      : code === "case_shape"
        ? new Set(["airframe", "single_item"])
        : code === "geo_precision"
          ? new Set(["point", "km_1", "km_10", "district", "region"])
          : undefined,
  closedEnum: (code) => code === "case_shape",
};
const check = (format: string, value: string) => checkFormat(parseFormat(format), value, ctx);

const CASES: [string, string, string][] = [
  ["hex:32", "0123456789abcdef0123456789ABCDEF", "ok"],
  ["hex:8", "0x0a:0b-0c 0d", "ok"],
  ["hex:8", "0a0b0c", "format_violation"],
  ["hex:7..40", "abcdef1", "ok"],
  ["hex:7..40", "abcdef", "format_violation"],
  ["hex:8 (`vvvv:pppp`)", "1d6b:0002", "ok"],
  ["guid", "{0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D}", "ok"],
  ["guid", "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d", "ok"],
  ["guid", "0A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D", "format_violation"],
  ["имя хоста", "Host-1.Example.test", "ok"],
  ["имя хоста", "-x", "format_violation"],
  ["имя хоста", "x_y", "format_violation"],
  ["имя хоста", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`, "ok"],
  ["имя хоста", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`, "format_violation"],
  ["домен", "Пример.РФ", "ok"],
  ["домен", "x", "format_violation"],
  ["ip", "192.0.2.1", "ok"],
  ["ip", "2001:db8::1", "ok"],
  ["ip", "192.0.2.1/24", "format_violation"],
  ["ip", "192.0.2.1:80", "format_violation"],
  ["ip-cidr", "10.0.0.0/8", "ok"],
  ["ip-cidr", "2001:db8::/32", "ok"],
  ["ip-cidr", "10.0.0.0/33", "format_violation"],
  ["url", "https://x.test/y", "ok"],
  ["url", "не адрес", "format_violation"],
  ["ssh-ключ", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB x@y", "ok"],
  ["ssh-ключ", "SHA256:RXm/ruZ0eTzRXKwi1AQEDynB0VgHQ2ac9KPSFdf/YnA", "ok"],
  ["ssh-ключ", "SHA256:short", "format_violation"],
  ["base64:44", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=", "ok"],
  ["base64:44", "AQEB", "format_violation"],
  ["серийный", "AB-12 x", "ok"],
  ["серийный", "x\u0007", "format_violation"],
  ["серийный", "x".repeat(65), "format_violation"],
  ["серийный (15 цифр)", "123456789012345", "ok"],
  ["серийный (15 цифр)", "12345678901234", "format_violation"],
  ["серийный (19–20 цифр)", "1234567890123456789", "ok"],
  ["строка:32", "x y", "ok"],
  ["строка:32", "x".repeat(33), "format_violation"],
  ["строка:32", "x\ny", "format_violation"],
  ["строка:64 без пробелов", "x y", "format_violation"],
  ["строка:255 (`$id$…`)", "$6$x$y", "ok"],
  ["целое", "1 000", "ok"],
  ["целое", "-5", "ok"],
  ["целое", "x", "format_violation"],
  ["целое:1–65535", "65535", "ok"],
  ["целое:1–65535", "65536", "format_violation"],
  ["целое:1–65535", "0", "format_violation"],
  ["дата-время", "2026-10-19", "ok"],
  ["дата-время", "2026-10-19T10", "ok"],
  ["дата-время", "2026-10-19T10:00:00Z", "ok"],
  ["дата-время", "2026-10-19/2026-10-20", "ok"],
  ["дата-время", "19.10.2026", "format_violation"],
  ["тайл", "N55E037", "ok"],
  ["тайл", "N55E37", "format_violation"],
  ["гео", "1.5,2.5", "ok"],
  ["гео", "1.5,2.5;1.6,2.6;1.7,2.5", "ok"],
  ["гео", "95,37", "format_violation"],
  // T128, DICT-65: точность из перечня geo_precision — после координат через пробел (приложение §5);
  // код вне открытого перечня — «вне Словаря», а не нарушение формата (T148). Координаты условные (T161).
  ["гео", "1.5,2.5 km_10", "ok"],
  ["гео", "1.5,2.5;1.6,2.6;1.7,2.5 district", "ok"],
  ["гео", "1.5,2.5 km_99", "out_of_dictionary"],
  ["гео", "1.5,2.5 km_10 x", "format_violation"],
  ["перечень:os_distro", "debian", "ok"],
  ["перечень:os_distro", "x", "out_of_dictionary"],
  ["перечень:case_shape", "x", "closed_violation"],
  ["перечень:purpose ×N", "x", "out_of_dictionary"],
  ["параметр", "ARMING_CHECK=1", "ok"],
  ["параметр", "=1", "format_violation"],
];

for (const [format, value, expected] of CASES) {
  test(`${format}: ${JSON.stringify(value.length > 40 ? value.slice(0, 40) + "…" : value)} → ${expected}`, () => {
    assert.equal(check(format, value), expected);
  });
}

test("пустая строка и строка из пробелов — не значение (DATA-26)", () => {
  assert.equal(check("строка:32", ""), "not_a_value");
  assert.equal(check("hex:8", "   "), "not_a_value");
});

test("×N у перечня — несколько Индикаторов одного типа на объекте", () => {
  assert.equal(parseFormat("перечень:proto ×N").multiple, true);
  assert.equal(parseFormat("перечень:os_distro").multiple, false);
});

test("неизвестный формат — ошибка разбора, а не пропуск проверки", () => {
  assert.throws(() => parseFormat("число"), FormatSpecError);
});

test("T233, DICT-33: IPv4 — только в последних группах IPv6", () => {
  assert.equal(check("ip", "::1.2.3.4"), "ok");
  assert.notEqual(check("ip", "1.2.3.4::"), "ok");
  assert.notEqual(check("ip", "1.2.3.4::1"), "ok");
});

test("T242, DICT-30: формат «домен» — только имя домена, не адрес URL и не числовой адрес", () => {
  for (const v of ["example.test/login?x=1", "EX%41MPLE.test#a", "example.test\\x", "0x7f.1", "127.1", "1.2.3"]) assert.notEqual(check("домен", v), "ok", v);
  assert.equal(check("домен", "Пример.РФ"), "ok");
});

test("T256, DICT-30: формат «домен» — форма имени проверяется после отображения UTS #46", () => {
  for (const v of ["127。1", "127.１", "1.2.3。", "127．0．0．1"]) assert.notEqual(check("домен", v), "ok", v);
});

test("T266, приложение §5: «дата-время» — существующая дата, начало диапазона не позже конца, час с зоной", () => {
  for (const v of ["2026-02-30", "2026-04-31", "2026-02-29T10:00:00Z", "2026-13-01", "2026-01-01T24:00:00Z", "2026-05-01/2026-01-01"]) assert.notEqual(check("дата-время", v), "ok", v);
  for (const v of ["2024-02-29", "2026-01-01T10Z", "2026-01-01T10+03:00", "2026-01-01T10", "2026-01-01/2026-05-01", "2026-01-01T10:00:00.5Z"]) assert.equal(check("дата-время", v), "ok", v);
});

test("T284, T286, приложение §5: «серийный» — печатные знаки; «строка:N» — одна строка", () => {
  for (const v of ["ABC​", "AB﻿C", "AB­C"]) assert.notEqual(check("серийный", v), "ok", JSON.stringify(v));
  assert.equal(check("серийный", "AB-12 CD"), "ok");
  for (const v of ["a b", "a b", "a\u0085b", "a\u000bb", "a\u000cb"]) assert.notEqual(check("строка:10", v), "ok", JSON.stringify(v));
  assert.equal(check("строка:10", "a b"), "ok");
});
