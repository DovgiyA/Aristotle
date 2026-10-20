// T023 — сборка версии Словаря Сети из исходника без службы: Идентификаторы по Кодам из предыдущей
// версии, новым Кодам — UUIDv7, элементы не пропадают (research R5 фичи 005; DICT-09 … DICT-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SlovarFormatError, bodySha256, parseSlovarBody, parseStopListFile, serializeSignedDocument, type DictionarySource, type StopListFile } from "@aristotel/protocol";
import { DictionaryBuildError, buildVersion, readDictionarySource } from "../../src/dictionary/build.ts";

const SOURCE = join(import.meta.dirname, "..", "..", "..", "..", "dictionary", "source");
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function copy(src: DictionarySource): DictionarySource {
  return structuredClone(src);
}

test("версия 1: каждому Коду — UUIDv7, отчёт называет списки без значений", () => {
  const { doc, report } = buildVersion({ source: readDictionarySource(SOURCE) });
  const body = parseSlovarBody(doc.body);
  assert.equal(body.number, 1);
  assert.equal(body.previousSha256, null);
  for (const el of body.elements) assert.match(el.id, UUID7, el.code);
  assert.equal(new Set(body.elements.map((e) => e.id)).size, body.elements.length);
  assert.deepEqual(report.missingStopLists.sort(), ["ardupilot_firmware", "pi_gen_commits", "px4_firmware"]);
  assert.ok(body.programRequirements.normClasses.includes("строка-без-регистра"));
  assert.deepEqual(body.programRequirements.materialKinds, ["image", "logical_copy", "extracted_file", "photo", "crypto_task", "legacy_file", "external_source"]);
  assert.equal(doc.signatures.length, 0);
});

test("версия 2 с previous: Идентификаторы прежних Кодов те же, новому Коду — новый; previousSha256 — тождество предыдущей", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const next = copy(src);
  next.types.indicatorTypes.push({ ...next.types.indicatorTypes[0]!, code: "x_new_type", label: "x", legacyNames: [] });
  const v2 = buildVersion({ source: next, previous: serializeSignedDocument(v1.doc) });
  const b1 = parseSlovarBody(v1.doc.body);
  const b2 = parseSlovarBody(v2.doc.body);
  assert.equal(b2.number, 2);
  const id1 = new Map(b1.elements.map((e) => [`${e.kind}:${String(e.props["enum"] ?? "")}:${e.code}`, e.id]));
  for (const e of b2.elements) {
    const prev = id1.get(`${e.kind}:${String(e.props["enum"] ?? "")}:${e.code}`);
    if (e.code === "x_new_type") assert.equal(prev, undefined);
    else assert.equal(e.id, prev, e.code);
  }
  assert.equal(v2.report.newElements, 1);
  assert.equal(b2.previousSha256, bodySha256(v1.doc.body));
  // Элемент из версии 1 сохраняет sinceVersion = 1, новый — 2.
  assert.equal(b2.elements.find((e) => e.code === "x_new_type")?.sinceVersion, 2);
  assert.equal(b2.elements.find((e) => e.code === "hostname")?.sinceVersion, 1);
});

test("Код исчез из исходника — отказ (DICT-13): элемент можно только объявить устаревшим", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const gone = copy(src);
  gone.types.indicatorTypes = gone.types.indicatorTypes.filter((t) => t.code !== "hostname");
  assert.throws(() => buildVersion({ source: gone, previous: serializeSignedDocument(v1.doc) }), DictionaryBuildError);
  const deprecated = copy(src);
  deprecated.merges.deprecated = ["indicator_type:hostname"];
  const v2 = buildVersion({ source: deprecated, previous: serializeSignedDocument(v1.doc) });
  assert.equal(parseSlovarBody(v2.doc.body).elements.find((e) => e.code === "hostname")?.state, "deprecated");
});

test("неизвестный программе Класс нормализации — отказ сборки", () => {
  const src = copy(readDictionarySource(SOURCE));
  src.types.indicatorTypes[0]!.normClass = "имя-хоста/2";
  assert.throws(() => buildVersion({ source: src }), DictionaryBuildError);
});

test("файлы списков входят в версию; повтор строки в списке и диапазон не у ip — отказ", () => {
  const src = readDictionarySource(SOURCE);
  const file: StopListFile = {
    format: "aristotel/stop-list/v1",
    code: "px4_firmware",
    label: "Прошивки PX4",
    source: "x",
    builtAt: "2026-10-13",
    rows: [{ type: "file_sha256", kind: "value", value: "a".repeat(64), note: "PX4 x · y" }],
  };
  const { doc, report } = buildVersion({ source: src, stopListFiles: [file] });
  assert.ok(parseSlovarBody(doc.body).stopLists.some((l) => l.code === "px4_firmware" && l.rows.length === 1));
  assert.ok(!report.missingStopLists.includes("px4_firmware"));
  assert.throws(() => buildVersion({ source: src, stopListFiles: [{ ...file, rows: [file.rows[0]!, { ...file.rows[0]!, value: "A".repeat(64) }] }] }), DictionaryBuildError);
  assert.throws(() => buildVersion({ source: src, stopListFiles: [{ ...file, rows: [{ ...file.rows[0]!, kind: "range" }] }] }), DictionaryBuildError);
});

test("T092: следующая сборка переносит «поглощён → канон» и «устарел», даже если merges.json их не называет (DICT-12, DICT-13)", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const second = copy(src);
  second.merges.synonyms = [{ absorbed: "indicator_type:x509_cn", canonical: "indicator_type:x509_fingerprint" }];
  second.merges.deprecated = ["indicator_type:os_distro"];
  const v2 = buildVersion({ source: second, previous: serializeSignedDocument(v1.doc) });
  const v3 = buildVersion({ source: src, previous: serializeSignedDocument(v2.doc) });
  const b3 = parseSlovarBody(v3.doc.body);
  const cn = b3.elements.find((e) => e.kind === "indicator_type" && e.code === "x509_cn")!;
  const fp = b3.elements.find((e) => e.kind === "indicator_type" && e.code === "x509_fingerprint")!;
  assert.deepEqual([cn.state, cn.canonical], ["absorbed", fp.id]);
  assert.equal(b3.elements.find((e) => e.kind === "indicator_type" && e.code === "os_distro")?.state, "deprecated");
  assert.deepEqual(b3.merges, [], "склейка уже применена версией 2 — в merges версии 3 её нет");
});

test("T094: список Стоп-листа предыдущей версии без файла переносится целиком, отчёт его называет (DICT-46)", () => {
  const src = readDictionarySource(SOURCE);
  const file: StopListFile = { format: "aristotel/stop-list/v1", code: "px4_firmware", label: "Прошивки PX4", source: "x", builtAt: "2026-10-13", rows: [{ type: "file_sha256", kind: "value", value: "a".repeat(64), note: "x" }] };
  const v1 = buildVersion({ source: src, stopListFiles: [file] });
  const v2 = buildVersion({ source: src, previous: serializeSignedDocument(v1.doc) });
  const l1 = parseSlovarBody(v1.doc.body).stopLists.find((l) => l.code === "px4_firmware")!;
  const l2 = parseSlovarBody(v2.doc.body).stopLists.find((l) => l.code === "px4_firmware");
  assert.deepEqual(l2, l1);
  assert.deepEqual(v2.report.carriedStopLists, ["px4_firmware"]);
  assert.ok(!v2.report.missingStopLists.includes("px4_firmware"));
});

test("T116: смена Кода с записью в merges.renamed сохраняет Идентификатор (DICT-10); без записи — отказ", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const renamed = copy(src);
  renamed.types.indicatorTypes.find((t) => t.code === "key_bits")!.code = "key_size_bits";
  assert.throws(() => buildVersion({ source: renamed, previous: serializeSignedDocument(v1.doc) }), DictionaryBuildError);
  renamed.merges.renamed = [{ from: "indicator_type:key_bits", to: "indicator_type:key_size_bits" }];
  const v2 = buildVersion({ source: renamed, previous: serializeSignedDocument(v1.doc) });
  const id1 = parseSlovarBody(v1.doc.body).elements.find((e) => e.kind === "indicator_type" && e.code === "key_bits")!.id;
  assert.equal(parseSlovarBody(v2.doc.body).elements.find((e) => e.kind === "indicator_type" && e.code === "key_size_bits")?.id, id1);
  assert.equal(v2.report.newElements, 0);
});

// Phase 15: Convergence — T122 … T124, T130.

test("T122: смена Кода списка Стоп-листа через renamed — тот же Идентификатор, без дубля (DICT-46, DICT-64)", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const renamed = copy(src);
  renamed.stopLists.find((l) => l.code === "zerotier")!.code = "zerotier_planets";
  renamed.merges.renamed = [{ from: "stop_list:zerotier", to: "stop_list:zerotier_planets" }];
  const v2 = buildVersion({ source: renamed, previous: serializeSignedDocument(v1.doc) });
  const lists = parseSlovarBody(v2.doc.body).stopLists;
  assert.equal(new Set(lists.map((l) => l.id)).size, lists.length, "Идентификаторы списков не повторяются");
  assert.equal(lists.find((l) => l.code === "zerotier_planets")?.id, parseSlovarBody(v1.doc.body).stopLists.find((l) => l.code === "zerotier")!.id);
  assert.ok(!lists.some((l) => l.code === "zerotier"));
});

test("T123: синоним в себя, между видами или на неизвестный Код — отказ сборки (DICT-12)", () => {
  const src = readDictionarySource(SOURCE);
  for (const synonyms of [
    [{ absorbed: "indicator_type:x509_cn", canonical: "indicator_type:x509_cn" }],
    [{ absorbed: "indicator_type:x509_cn", canonical: "object_type:platform" }],
    [{ absorbed: "indicator_type:x509_cn", canonical: "indicator_type:no_such_type" }],
  ]) {
    const s = copy(src);
    s.merges.synonyms = synonyms;
    assert.throws(() => buildVersion({ source: s }), DictionaryBuildError, JSON.stringify(synonyms));
  }
});

test("T124: Код закрытого перечня поля программы не переименовывается (DICT-60, BANK-63)", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const s = copy(src);
  s.enums.find((e) => e.code === "material_kind")!.code = "material_kind_x";
  s.merges.renamed = [{ from: "enum:material_kind", to: "enum:material_kind_x" }];
  assert.throws(() => buildVersion({ source: s, previous: serializeSignedDocument(v1.doc) }), DictionaryBuildError);
});

test("T130: renamed проверяется — занятый to, смена вида, прежний Код ещё в исходнике; перенесённые строки проверяются заново", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const prev = serializeSignedDocument(v1.doc);
  const occupied = copy(src);
  occupied.merges.renamed = [{ from: "indicator_type:key_bits", to: "indicator_type:hostname" }];
  occupied.types.indicatorTypes = occupied.types.indicatorTypes.filter((t) => t.code !== "key_bits");
  assert.throws(() => buildVersion({ source: occupied, previous: prev }), DictionaryBuildError, "занятый to");
  const kind = copy(src);
  kind.types.indicatorTypes.find((t) => t.code === "key_bits")!.code = "key_size_bits";
  kind.merges.renamed = [{ from: "indicator_type:key_bits", to: "object_type:key_size_bits" }];
  assert.throws(() => buildVersion({ source: kind, previous: prev }), DictionaryBuildError, "смена вида");
  const stays = copy(src);
  stays.types.indicatorTypes.push({ ...stays.types.indicatorTypes.find((t) => t.code === "key_bits")!, code: "key_size_bits" });
  stays.merges.renamed = [{ from: "indicator_type:key_bits", to: "indicator_type:key_size_bits" }];
  assert.throws(() => buildVersion({ source: stays, previous: prev }), DictionaryBuildError, "прежний Код в исходнике");
  // Перенесённый список проверяется заново: строка, которая по новому Классу типа не нормализуется, — отказ.
  const file: StopListFile = { format: "aristotel/stop-list/v1", code: "px4_firmware", label: "x", source: "x", builtAt: "2026-10-13", rows: [{ type: "image_build", kind: "value", value: "a".repeat(40), note: "x" }] };
  const withList = buildVersion({ source: src, stopListFiles: [file] });
  const changed = copy(src);
  changed.types.indicatorTypes.find((t) => t.code === "image_build")!.normClass = "целое";
  assert.throws(() => buildVersion({ source: changed, previous: serializeSignedDocument(withList.doc) }), DictionaryBuildError, "перенесённая строка");
});

// Phase 16: Convergence — T146, T147, T155, T156.

test("T146: renamed и синоним для значений, которые программа читает по Коду, — отказ сборки", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const prev = serializeSignedDocument(v1.doc);
  const recode = copy(src);
  recode.enums.find((e) => e.code === "case_shape")!.values.find((v) => v.code === "single_item")!.code = "one_item";
  recode.merges.renamed = [{ from: "enum_value:case_shape.single_item", to: "enum_value:case_shape.one_item" }];
  assert.throws(() => buildVersion({ source: recode, previous: prev }), DictionaryBuildError, "case_shape.single_item");
  const storage = copy(src);
  storage.merges.synonyms = [{ absorbed: "enum_value:hw_kind.storage", canonical: "enum_value:hw_kind.sbc" }];
  assert.throws(() => buildVersion({ source: storage, previous: prev }), DictionaryBuildError, "hw_kind.storage");
});

test("T147: формат типа проверяется — неизвестный формат и перечень, которого нет, — отказ сборки", () => {
  const src = readDictionarySource(SOURCE);
  const missing = copy(src);
  missing.types.indicatorTypes.find((t) => t.code === "key_bits")!.format = "перечень:no_such_enum";
  assert.throws(() => buildVersion({ source: missing }), DictionaryBuildError, "перечень не из версии");
  const unknown = copy(src);
  unknown.types.indicatorTypes.find((t) => t.code === "key_bits")!.format = "число";
  assert.throws(() => buildVersion({ source: unknown }), DictionaryBuildError, "неизвестный формат");
});

test("T155: renamed списка Стоп-листа без списка с новым Кодом — отказ сборки (DICT-10, DICT-46)", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const lost = copy(src);
  lost.stopLists = lost.stopLists.filter((l) => l.code !== "zerotier");
  lost.merges.renamed = [{ from: "stop_list:zerotier", to: "stop_list:zt" }];
  assert.throws(() => buildVersion({ source: lost, previous: serializeSignedDocument(v1.doc) }), DictionaryBuildError);
});

test("T156: синоним между перечнями или значениями разных перечней — отказ сборки (DICT-12)", () => {
  const src = readDictionarySource(SOURCE);
  for (const synonyms of [
    [{ absorbed: "enum:fs_type", canonical: "enum:os_distro" }],
    [{ absorbed: "enum_value:fs_type.ext4", canonical: "enum_value:os_distro.debian" }],
  ]) {
    const s = copy(src);
    s.merges.synonyms = synonyms;
    assert.throws(() => buildVersion({ source: s }), DictionaryBuildError, JSON.stringify(synonyms));
  }
});

// Phase 17: Convergence — T162, T163.

test("T162: renamed и синоним элементов, которые программа находит по Коду, — отказ сборки", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const prev = serializeSignedDocument(v1.doc);
  const geo = copy(src);
  geo.types.objectTypes.find((o) => o.code === "geo_object")!.code = "geo_area";
  geo.merges.renamed = [{ from: "object_type:geo_object", to: "object_type:geo_area" }];
  assert.throws(() => buildVersion({ source: geo, previous: prev }), DictionaryBuildError, "geo_object");
  const hw = copy(src);
  hw.merges.synonyms = [{ absorbed: "indicator_type:hw_kind", canonical: "indicator_type:hw_model" }];
  assert.throws(() => buildVersion({ source: hw, previous: prev }), DictionaryBuildError, "hw_kind");
});

test("T163: ссылка на Код, которого нет в исходнике, — отказ сборки", () => {
  const src = readDictionarySource(SOURCE);
  const cases: [string, (s: ReturnType<typeof copy>) => void][] = [
    ["поле шаблона", (s) => s.classes.templates[0]!.blocks[0]!.fields[0]!.target.indicatorTypes = ["no_such_type"]],
    ["объект типа", (s) => (s.types.indicatorTypes.find((t) => t.code === "key_bits")!.object = "no_such_object")],
    ["опознающий", (s) => (s.types.objectTypes[0]!.identifying = ["no_such_type"])],
    ["конец связи", (s) => (s.types.linkTypes[0]!.to = ["no_such_object"])],
  ];
  for (const [name, change] of cases) {
    const s = copy(src);
    change(s);
    assert.throws(() => buildVersion({ source: s }), DictionaryBuildError, name);
  }
});

test("T171, T172: renamed перечня hw_kind и ссылка «@bogus» — отказ сборки (DICT-10, DICT-60)", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const renamed = copy(src);
  renamed.enums.find((e) => e.code === "hw_kind")!.code = "hw_kind2";
  renamed.types.indicatorTypes.find((t) => t.code === "hw_kind")!.format = "перечень:hw_kind2";
  renamed.merges.renamed = [{ from: "enum:hw_kind", to: "enum:hw_kind2" }];
  assert.throws(() => buildVersion({ source: renamed, previous: serializeSignedDocument(v1.doc) }), DictionaryBuildError, "hw_kind");
  const bogus = copy(src);
  bogus.types.linkTypes[0]!.to = ["@bogus"];
  assert.throws(() => buildVersion({ source: bogus }), DictionaryBuildError, "@bogus");
});

test("T188: файл списка с пояснением без печатных символов — отказ сборки (DICT-41)", () => {
  const src = readDictionarySource(SOURCE);
  const file: StopListFile = { format: "aristotel/stop-list/v1", code: "px4_firmware", label: "x", source: "x", builtAt: "2026-10-13", rows: [{ type: "file_sha256", kind: "value", value: "a".repeat(64), note: " " }] };
  assert.throws(() => buildVersion({ source: src, stopListFiles: [file] }));
});

test("T199: синоним видов объектов разной роли — отказ сборки; одной роли — проходит (DICT-12, DATA-09, DATA-10)", () => {
  const src = readDictionarySource(SOURCE);
  const mixed = copy(src);
  mixed.merges.synonyms = [{ absorbed: "object_type:crypto", canonical: "object_type:key" }];
  assert.throws(() => buildVersion({ source: mixed }), DictionaryBuildError);
  const same = copy(src);
  same.merges.synonyms = [{ absorbed: "object_type:crypto", canonical: "object_type:event" }];
  assert.doesNotThrow(() => buildVersion({ source: same }));
});

test("T201: тело и файл списка — правильно построенный Юникод, иначе отказ (DICT-40, DICT-41)", () => {
  const src = readDictionarySource(SOURCE);
  const label = copy(src);
  label.types.objectTypes[0]!.label = "x\ud800";
  assert.throws(() => buildVersion({ source: label }), SlovarFormatError);
  const file = { format: "aristotel/stop-list/v1", code: "px4_firmware", label: "x", source: "x", builtAt: "2026-10-13", rows: [{ type: "file_sha256", kind: "value", value: "a".repeat(64), note: "x\udc00" }] };
  assert.throws(() => parseStopListFile(JSON.stringify(file)), SlovarFormatError);
  assert.throws(() => buildVersion({ source: src, stopListFiles: [file as StopListFile] }), SlovarFormatError);
});

test("T204: перечень поля программы с closed: false — отказ сборки (DICT-60)", () => {
  const s = copy(readDictionarySource(SOURCE));
  s.enums.find((e) => e.code === "item_class")!.closed = false;
  assert.throws(() => buildVersion({ source: s }), DictionaryBuildError);
});

test("T217: второй шаблон того же Класса и подтипа — отказ сборки (DATA-23)", () => {
  const s = copy(readDictionarySource(SOURCE));
  s.classes.templates.push(structuredClone(s.classes.templates[0]!));
  assert.throws(() => buildVersion({ source: s }), DictionaryBuildError);
});

test("T218: строка range проверяется Классом канона — тип, склеенный в ip-тип, проходит и с --previous (DICT-41)", () => {
  const s = copy(readDictionarySource(SOURCE));
  s.merges.synonyms = [{ absorbed: "indicator_type:domain", canonical: "indicator_type:ip" }];
  const file: StopListFile = { format: "aristotel/stop-list/v1", code: "px4_firmware", label: "x", source: "x", builtAt: "2026-10-13", rows: [{ type: "domain", kind: "range", value: "10.0.0.0/8", note: "частный" }] };
  const v1 = buildVersion({ source: s, stopListFiles: [file] });
  const next = copy(readDictionarySource(SOURCE));
  assert.doesNotThrow(() => buildVersion({ source: next, previous: serializeSignedDocument(v1.doc) }));
});

test("T219: неизвестный ключ в merges.deprecated — отказ сборки (DICT-13)", () => {
  const s = copy(readDictionarySource(SOURCE));
  s.merges.deprecated = ["indicator_type:hostnme"];
  assert.throws(() => buildVersion({ source: s }), DictionaryBuildError);
});

test("T231: renamed значения перечня в другой перечень — отказ сборки (DICT-10, T183)", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const moved = copy(src);
  const purpose = moved.enums.find((e) => e.code === "purpose")!;
  const value = purpose.values.splice(purpose.values.findIndex((v) => v.code === "video_recon"), 1)[0]!;
  moved.enums.find((e) => e.code === "media_type")!.values.push(value);
  moved.merges.renamed = [{ from: "enum_value:purpose.video_recon", to: "enum_value:media_type.video_recon" }];
  assert.throws(() => buildVersion({ source: moved, previous: serializeSignedDocument(v1.doc) }), DictionaryBuildError);
});

test("T232: один поглощённый — один канон: синоним в два канона и местный тип в два канона — отказ сборки (DICT-12, DICT-22)", () => {
  const src = readDictionarySource(SOURCE);
  const twice = copy(src);
  twice.merges.synonyms = [
    { absorbed: "indicator_type:x509_cn", canonical: "indicator_type:x509_fingerprint" },
    { absorbed: "indicator_type:x509_cn", canonical: "indicator_type:hostname" },
  ];
  assert.throws(() => buildVersion({ source: twice }), DictionaryBuildError);
  const same = copy(src);
  same.merges.synonyms = [
    { absorbed: "indicator_type:x509_cn", canonical: "indicator_type:x509_fingerprint" },
    { absorbed: "indicator_type:x509_cn", canonical: "indicator_type:x509_fingerprint" },
  ];
  assert.doesNotThrow(() => buildVersion({ source: same }), "повтор той же склейки допустим");
  const local = copy(src);
  const localId = "0190a000-0000-7000-8000-00000000dddd";
  local.merges.localTypes = [
    { local: "A:x", localId, canonical: "hostname" },
    { local: "A:x", localId, canonical: "domain" },
  ];
  assert.throws(() => buildVersion({ source: local }), DictionaryBuildError);
});

test("T235: неизвестный программе вид Материала — отказ сборки (DICT-01, BANK-63)", () => {
  const s = copy(readDictionarySource(SOURCE));
  s.enums.find((e) => e.code === "material_kind")!.values.push({ code: "x_kind", label: "x" });
  assert.throws(() => buildVersion({ source: s }), DictionaryBuildError);
});

test("T248: формат поля шаблона переносится сборкой и проверяется (DATA-23, DICT-08)", () => {
  const src = readDictionarySource(SOURCE);
  const withFormat = copy(src);
  withFormat.classes.templates[0]!.blocks[0]!.fields[0]!.format = "строка:32";
  const body = parseSlovarBody(buildVersion({ source: withFormat }).doc.body);
  assert.ok(body.templates.some((t) => t.blocks.some((b) => b.fields.some((f) => f.format === "строка:32"))), "format не потерян");
  const bad = copy(src);
  bad.classes.templates[0]!.blocks[0]!.fields[0]!.format = "не формат";
  assert.throws(() => buildVersion({ source: bad }), DictionaryBuildError);
});

test("T249: лишнее или опечатанное поле в файле исходника — отказ с именем файла (DICT-01)", async (t) => {
  const { cpSync, mkdtempSync, readFileSync: read, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "src-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(SOURCE, dir, { recursive: true });
  const types = JSON.parse(read(join(dir, "types.json"), "utf8")) as { indicatorTypes: Record<string, unknown>[] };
  const withCross = types.indicatorTypes.find((x) => x["crossCompare"] !== undefined)!;
  withCross["crossCompar"] = withCross["crossCompare"];
  delete withCross["crossCompare"];
  writeFileSync(join(dir, "types.json"), JSON.stringify(types));
  assert.throws(() => readDictionarySource(dir), (e: Error) => /types\.json/.test(e.message) && /crossCompar/.test(e.message));
});

test("T258: шаблон строки Сети — в нормальной форме Класса, повтор — по нормализованной форме (DICT-41)", () => {
  const src = readDictionarySource(SOURCE);
  const file = (rows: StopListFile["rows"]): StopListFile => ({ format: "aristotel/stop-list/v1", code: "px4_firmware", label: "x", source: "x", builtAt: "2026-10-13", rows });
  assert.throws(() => buildVersion({ source: src, stopListFiles: [file([{ type: "hostname", kind: "pattern", value: "OrangePi*", note: "x" }])] }), DictionaryBuildError, "не совпадёт ни с чем");
  assert.throws(
    () =>
      buildVersion({
        source: src,
        stopListFiles: [file([{ type: "domain", kind: "pattern", value: "*.Example.test", note: "x" }, { type: "domain", kind: "pattern", value: "*.example.test", note: "x" }])],
      }),
    DictionaryBuildError,
    "повтор по нормализованной форме",
  );
  assert.doesNotThrow(() => buildVersion({ source: src, stopListFiles: [file([{ type: "ip", kind: "pattern", value: "192.168.*", note: "x" }])] }));
});

test("T259: renamed значения перечня добавляет прежний Код синонимом перечня (DICT-10)", () => {
  const src = readDictionarySource(SOURCE);
  const v1 = buildVersion({ source: src });
  const s = copy(src);
  const purpose = s.enums.find((e) => e.code === "purpose")!;
  purpose.values.find((v) => v.code === "video_recon")!.code = "video_recon2";
  s.merges.renamed = [{ from: "enum_value:purpose.video_recon", to: "enum_value:purpose.video_recon2" }];
  const body = parseSlovarBody(buildVersion({ source: s, previous: serializeSignedDocument(v1.doc) }).doc.body);
  const en = body.elements.find((e) => e.kind === "enum" && e.code === "purpose")!;
  assert.equal((en.props["aliases"] as Record<string, string> | undefined)?.["video_recon"], "video_recon2");
});

test("T278: значение строки Стоп-листа проходит формат своего типа (приложение §8)", () => {
  const src = readDictionarySource(SOURCE);
  const file = (rows: StopListFile["rows"]): StopListFile => ({ format: "aristotel/stop-list/v1", code: "px4_firmware", label: "x", source: "x", builtAt: "2026-10-13", rows });
  for (const row of [{ type: "domain", kind: "value", value: "localhost", note: "x" }, { type: "file_sha256", kind: "value", value: "ab", note: "x" }] as const) {
    assert.throws(() => buildVersion({ source: src, stopListFiles: [file([row])] }), DictionaryBuildError, row.value);
  }
  assert.doesNotThrow(() => buildVersion({ source: src }), "строки исходника проходят свои форматы");
});

test("T300: closed: true у перечня не поля программы — отказ сборки (DICT-60)", () => {
  const s = copy(readDictionarySource(SOURCE));
  s.enums.find((e) => e.code === "os_distro")!.closed = true;
  assert.throws(() => buildVersion({ source: s }), DictionaryBuildError);
});

test("T304: тип Индикатора с перечнем поля программы — отказ сборки (DICT-60)", () => {
  const s = copy(readDictionarySource(SOURCE));
  s.types.indicatorTypes[0]!.format = "перечень:case_shape";
  assert.throws(() => buildVersion({ source: s }), DictionaryBuildError);
});
