// T026 — все отказы применения версии Словаря Сети (SC-003; contracts/slovar-v1.md «Отказы»; DICT-10,
// DICT-11, DICT-13, DICT-17, DICT-41, DICT-58; Clarifications фичи 005). Ни один отказ не меняет
// Словарь; у каждого — запись dictionary.reject с причиной.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOVAR_FORMAT, type SignedDocument, type SlovarBody } from "@aristotel/protocol";
import { callMaintenance, startTestService, type TestService } from "../../support/harness.ts";
import { T, applyTestDictionary, nextTestVersion, proposeLocal, signWithTestCoordinator, testDictionaryBody, testDictionaryDocument } from "../../support/dictionary.ts";

const submit = (svc: TestService, doc: unknown) => callMaintenance(svc, "POST", "/api/dictionary/versions", doc);
const elements = (svc: TestService) => svc.db.prepare("SELECT id, state FROM dict_element ORDER BY id").all().map((r) => ({ ...r }));
const rejects = (svc: TestService) => svc.db.prepare("SELECT details FROM journal WHERE action = 'dictionary.reject' ORDER BY seq").all().map((r) => JSON.parse(String(r["details"])).reason);

async function expectReject(svc: TestService, doc: unknown, reason: string): Promise<Record<string, unknown>> {
  const before = elements(svc);
  const res = await submit(svc, doc);
  assert.equal(res.statusCode, 422, res.body);
  assert.deepEqual([res.json().error, res.json().reason], ["dictionary_rejected", reason]);
  assert.deepEqual(elements(svc), before, `${reason}: Словарь не тронут`);
  assert.equal(rejects(svc).at(-1), reason);
  return res.json();
}

const v2 = (v1: SignedDocument, change: (b: SlovarBody) => void) => signWithTestCoordinator(nextTestVersion(v1, change));

test("format: тело не по схеме и не JSON", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, signWithTestCoordinator({ format: SLOVAR_FORMAT, body: "{не json", signatures: [] }), "format");
  await expectReject(svc, v2(v1, (b) => ((b as unknown as Record<string, unknown>)["extra"] = 1)), "format");
});

test("stale, gap (с ожидаемым номером), conflict, тот же документ — 200", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  assert.equal((await submit(svc, v1)).statusCode, 200);
  const second = v2(v1, () => {});
  assert.equal((await submit(svc, second)).statusCode, 201);
  await expectReject(svc, v1, "stale");
  const fourth = signWithTestCoordinator(nextTestVersion(nextTestVersion(second, () => {}), () => {}));
  const gap = await expectReject(svc, fourth, "gap");
  assert.equal(gap["expected"], 3);
  const other = v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("username"), "value", "w", "другое тело"]));
  await expectReject(svc, other, "conflict");
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'dictionary.conflict'").get()?.["n"], 1);
});

test("chain: previousSha256 не равен тождеству применённой", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.previousSha256 = "0".repeat(64))), "chain");
});

test("unsupported: неизвестный Класс нормализации, вид Материала, вид элемента", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => b.programRequirements.normClasses.push("имя-хоста/2")), "unsupported");
  await expectReject(svc, v2(v1, (b) => b.programRequirements.materialKinds.push("x_kind")), "unsupported");
  await expectReject(
    svc,
    v2(v1, (b) => b.elements.push({ id: "0190a000-0000-7000-8000-ffffffffffff", code: "x", label: "x", kind: "x_kind" as never, state: "active", sinceVersion: 2, props: {} })),
    "unsupported",
  );
});

test("content: пропал элемент, сменился Идентификатор Кода, повтор Кода, склейка на несуществующий, диапазон не у ip", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements = b.elements.filter((e) => e.code !== "hostname"))), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.code === "hostname")!.id = "0190a000-0000-7000-8000-eeeeeeeeeeee")), "content");
  await expectReject(svc, v2(v1, (b) => b.elements.push({ ...b.elements.find((e) => e.code === "hostname")!, id: "0190a000-0000-7000-8000-dddddddddddd" })), "content");
  await expectReject(svc, v2(v1, (b) => b.merges.push({ absorbed: T.indicator("hostname"), canonical: "0190a000-0000-7000-8000-cccccccccccc" })), "content");
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("hostname"), "range", "10.0.0.0/8", "п"])), "content");
});

test("до Реестра Сети подпись проверить нечем — 409 network_not_launched", async (t) => {
  const svc = await startTestService(t);
  const res = await submit(svc, signWithTestCoordinator(testDictionaryDocument()));
  assert.deepEqual([res.statusCode, res.json().error], [409, "network_not_launched"]);
});

test("T079: тот же номер с испорченной подписью — signature, а не conflict; развилки в журнале нет", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const tampered = { ...v1, body: v1.body.replace('"issuedAt":"2026', '"issuedAt":"2027') };
  await expectReject(svc, tampered, "signature");
  assert.equal(svc.db.prepare("SELECT count(*) AS n FROM journal WHERE action = 'dictionary.conflict'").get()?.["n"], 0);
});

test("T092: «поглощён» и «устарел» не возвращаются в «действует» (DICT-12, DICT-13)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const second = v2(v1, (b) => {
    const callsign = b.elements.find((e) => e.id === T.indicator("callsign"))!;
    callsign.state = "absorbed";
    callsign.canonical = T.indicator("username");
    b.merges.push({ absorbed: T.indicator("callsign"), canonical: T.indicator("username") });
    b.elements.find((e) => e.id === T.indicator("hostname"))!.state = "deprecated";
  });
  assert.equal((await submit(svc, second)).statusCode, 201);
  const back = (change: (b: SlovarBody) => void) => signWithTestCoordinator(nextTestVersion(second, change));
  await expectReject(
    svc,
    back((b) => {
      const callsign = b.elements.find((e) => e.id === T.indicator("callsign"))!;
      callsign.state = "active";
      delete callsign.canonical;
    }),
    "content",
  );
  await expectReject(svc, back((b) => (b.elements.find((e) => e.id === T.indicator("hostname"))!.state = "active")), "content");
  assert.equal((await submit(svc, back(() => {}))).statusCode, 201, "состояния перенесены — версия применяется");
});

test("T094: список Стоп-листа Сети не пропадает из следующей версии (DICT-46, DICT-13)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.stopLists = b.stopLists.slice(1))), "content");
});

test("T095: значение перечня material_kind, которого программа не знает, — unsupported и без programRequirements (BANK-63)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(
    svc,
    v2(v1, (b) => b.elements.push({ id: "0190a000-0000-7000-8000-fffffffffff1", code: "x_kind", label: "x", kind: "enum_value", state: "active", sinceVersion: 2, props: { enum: T.enumOf("material_kind") } })),
    "unsupported",
  );
});

test("T104: склейка в merges без состояния «поглощён» у элемента — content (DICT-12)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => b.merges.push({ absorbed: T.indicator("callsign"), canonical: T.indicator("username") })), "content");
});

test("T115: неподписанная версия с неизвестным Классом — signature, подпись проверяется раньше требований (research R6)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, nextTestVersion(v1, (b) => b.programRequirements.normClasses.push("имя-хоста/2")), "signature");
});

// Phase 15: Convergence — T121 … T124, T131.

test("T121: тело не по форме — format, а не 500 (contracts/slovar-v1.md «Отказы»)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, signWithTestCoordinator({ format: SLOVAR_FORMAT, body: "null", signatures: [] }), "format");
  await expectReject(svc, { format: SLOVAR_FORMAT, body: "null", signatures: [] }, "format");
  const raw = (patch: Record<string, unknown>) => {
    const next = nextTestVersion(v1, () => {});
    return signWithTestCoordinator({ ...next, body: JSON.stringify({ ...JSON.parse(next.body), ...patch }) });
  };
  await expectReject(svc, raw({ elements: {} }), "format");
  await expectReject(svc, raw({ elements: [null] }), "format");
  await expectReject(svc, raw({ programRequirements: { normClasses: 5, materialKinds: [] } }), "format");
  await expectReject(svc, raw({ programRequirements: { normClasses: "abc", materialKinds: [] } }), "format");
});

test("T122: повтор id или Кода списка Стоп-листа — content (DICT-64, DICT-46)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => b.stopLists.push({ ...structuredClone(b.stopLists[0]!), code: "x_other" })), "content");
  await expectReject(svc, v2(v1, (b) => b.stopLists.push({ ...structuredClone(b.stopLists[0]!), id: "0190a000-0000-7000-8000-0000000a0122" })), "content");
});

test("T123: синоним — того же вида, не сам в себя, без циклов (DICT-12)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const absorb = (b: SlovarBody, from: string, to: string) => {
    const el = b.elements.find((e) => e.id === from)!;
    el.state = "absorbed";
    el.canonical = to;
    b.merges.push({ absorbed: from, canonical: to });
  };
  await expectReject(svc, v2(v1, (b) => absorb(b, T.indicator("callsign"), T.indicator("callsign"))), "content");
  await expectReject(svc, v2(v1, (b) => absorb(b, T.indicator("callsign"), T.object("operator"))), "content");
  await expectReject(
    svc,
    v2(v1, (b) => {
      absorb(b, T.indicator("callsign"), T.indicator("username"));
      absorb(b, T.indicator("username"), T.indicator("callsign"));
    }),
    "content",
  );
});

test("T124: Код закрытого перечня поля программы не меняется — content (DICT-60, BANK-63)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  for (const code of ["material_kind", "item_class"]) {
    await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.enumOf(code))!.code = `${code}_x`)), "content");
  }
});

test("T131: новое «поглощён» без merges и смена канона поглощённого — content (DICT-12)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(
    svc,
    v2(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.indicator("callsign"))!;
      el.state = "absorbed";
      el.canonical = T.indicator("username");
    }),
    "content",
  );
  const second = v2(v1, (b) => {
    const el = b.elements.find((e) => e.id === T.indicator("callsign"))!;
    el.state = "absorbed";
    el.canonical = T.indicator("username");
    b.merges.push({ absorbed: T.indicator("callsign"), canonical: T.indicator("username") });
  });
  assert.equal((await submit(svc, second)).statusCode, 201);
  await expectReject(svc, signWithTestCoordinator(nextTestVersion(second, (b) => (b.elements.find((e) => e.id === T.indicator("callsign"))!.canonical = T.indicator("domain")))), "content");
});

// Phase 16: Convergence — T146, T156.

test("T146: значения, которые программа читает по Коду, не перекодируются и не склеиваются (DICT-60)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.value("case_shape", "single_item"))!.code = "one_item")), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.value("hw_kind", "storage"))!.code = "disk")), "content");
  await expectReject(
    svc,
    v2(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.value("case_shape", "airframe"))!;
      el.state = "absorbed";
      el.canonical = T.value("case_shape", "single_item");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
    }),
    "content",
  );
});

test("T156: синоним — между типами одного вида или значениями одного перечня; местная склейка — в тип Индикатора (DICT-12, DICT-22)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const absorb = (b: SlovarBody, from: string, to: string) => {
    const el = b.elements.find((e) => e.id === from)!;
    el.state = "absorbed";
    el.canonical = to;
    b.merges.push({ absorbed: from, canonical: to });
  };
  await expectReject(svc, v2(v1, (b) => absorb(b, T.value("fs_type", "ext4"), T.value("os_distro", "debian"))), "content");
  await expectReject(svc, v2(v1, (b) => absorb(b, T.enumOf("fs_type"), T.enumOf("os_distro"))), "content");
  await expectReject(svc, v2(v1, (b) => b.merges.push({ local: "A:x", localId: "0190a000-0000-7000-8000-0000000a0156", canonical: T.enumOf("os_distro") })), "content");
  assert.equal((await submit(svc, v2(v1, (b) => absorb(b, T.value("fs_type", "vfat"), T.value("fs_type", "ext4"))))).statusCode, 201, "значения одного перечня — можно");
});

// Phase 17: Convergence — T162, T163.

test("T162: элементы, которые программа находит по Коду, не перекодируются и не поглощаются (DICT-10, DICT-60)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.object("geo_object"))!.code = "geo_area")), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.indicator("hw_kind"))!.code = "hw_type")), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.enumOf("geo_precision"))!.code = "precision")), "content");
  await expectReject(
    svc,
    v2(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.object("hw_element"))!;
      el.state = "absorbed";
      el.canonical = T.object("operator");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
    }),
    "content",
  );
});

test("T163: ссылка на элемент не из версии — content (DICT-10)", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const ghost = "0190a000-0000-7000-8000-0000000a0163";
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.indicator("hostname"))!.props["object"] = ghost)), "content");
  await expectReject(svc, v2(v1, (b) => (b.templates[0]!.blocks[0]!.fields[1]!.target["indicatorTypes"] = [ghost])), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.link("authored_by"))!.props["to"] = [ghost])), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.object("operator"))!.props["identifying"] = [ghost])), "content");
});

test("T171, DICT-60: перечень hw_kind не переименовывается — hw_kind.storage не обходится", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.enumOf("hw_kind"))!.code = "hw_kind2")), "content");
});

test("T172, DICT-10: ссылка с «@» — только из закреплённого списка", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.link("authored_by"))!.props["to"] = ["@bogus"])), "content");
});

test("T179, DICT-60: элемент, который программа находит по Коду, не приходит «поглощённым» и в версии 1", async (t) => {
  const svc = await startTestService(t);
  const body = testDictionaryBody();
  const storage = body.elements.find((e) => e.id === T.value("hw_kind", "storage"))!;
  storage.state = "absorbed";
  storage.canonical = T.value("hw_kind", "sbc");
  body.merges.push({ absorbed: storage.id, canonical: storage.canonical });
  await assert.rejects(applyTestDictionary(svc, signWithTestCoordinator({ format: SLOVAR_FORMAT, body: JSON.stringify(body), signatures: [] })));
  assert.equal(rejects(svc).at(-1), "content");
});

test("T180, DICT-10: особые знаки «@» — только в концах связи, object типа и objectKind поля", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.object("operator"))!.props["identifying"] = ["@item"])), "content");
  await expectReject(svc, v2(v1, (b) => (b.templates[0]!.blocks[0]!.fields[1]!.target["indicatorTypes"] = ["@record"])), "content");
});

test("T176, DICT-41: строка range версии с неразбираемым CIDR — content, а не 500", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("ip"), "range", "10.0.0.0", "без маски"])), "content");
});

// Phase 20: Convergence — T182, T183, T185.

test("T182, DICT-41: строка range Сети при типе, переставшем быть ip, — content, а не 500", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.indicator("ip"))!.props["normClass"] = "строка")), "content");
  await expectReject(
    svc,
    v2(v1, (b) => {
      const ip = b.elements.find((e) => e.id === T.indicator("ip"))!;
      ip.state = "absorbed";
      ip.canonical = T.indicator("domain");
      b.merges.push({ absorbed: ip.id, canonical: ip.canonical });
    }),
    "content",
  );
});

test("T183, DICT-60: значение перечня — в перечне версии и не переходит в другой", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.value("item_class", "companion"))!.props["enum"] = "0190a000-0000-7000-8000-0000000a0183")), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.value("os_distro", "ubuntu"))!.props["enum"] = T.enumOf("fs_type"))), "content");
});

test("T185, DICT-10: ссылка ведёт на элемент нужного вида", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.templates[0]!.class = T.indicator("hostname"))), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.object("operator"))!.props["identifying"] = [T.object("key")])), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.indicator("hostname"))!.props["object"] = T.indicator("serial"))), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.link("authored_by"))!.props["to"] = [T.indicator("serial")])), "content");
  await expectReject(svc, v2(v1, (b) => (b.templates[0]!.blocks[0]!.fields[1]!.target["link"] = T.indicator("serial"))), "content");
});

// Phase 21: Convergence — T188, T189.

test("T188, DICT-17: пояснение строки Стоп-листа Сети без печатных символов — отказ, а не 500", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  for (const note of [" ", "   ", "\u0000x"]) {
    const res = await submit(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("username"), "value", "zz", note])));
    assert.equal(res.statusCode, 422, `${JSON.stringify(note)}: ${res.body}`);
  }
});

test("T189, DICT-22: Идентификатор Сети, совпавший с местным элементом, — content, а не 500", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const u1 = svc.addMember("У1");
  const local = await proposeLocal(svc, u1, "type", { code: "x_quirk", label: "x", object: T.object("operator"), format: "строка:64" });
  const localId = local.json().resultId as string;
  await expectReject(
    svc,
    v2(v1, (b) => b.elements.push({ id: localId, code: "x_quirk", label: "x", kind: "indicator_type", state: "active", sinceVersion: 2, props: { object: T.object("operator"), format: "строка:64", comparable: false, normClass: "строка", identifying: "none", autoSecret: false } })),
    "content",
  );
});

test("T199, DICT-12: склейка видов объектов разной роли (часть Изделия в узел) — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(
    svc,
    v2(v1, (b) => {
      const el = b.elements.find((e) => e.id === T.object("platform"))!;
      el.state = "absorbed";
      el.canonical = T.object("operator");
      b.merges.push({ absorbed: el.id, canonical: el.canonical });
    }),
    "content",
  );
});

test("T201, DICT-40: текст тела версии — правильно построенный Юникод, иначе format", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.object("operator"))!.label = "x\ud800")), "format");
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("username"), "value", "zz", "x\udc00"])), "format");
});

test("T204, DICT-60: перечень поля программы с closed: false — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.enumOf("item_class"))!.props["closed"] = false)), "content");
});

test("T206, DICT-10: применение проверяет формат типа и строки Стоп-листа, как сборка", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const typeOf = (b: SlovarBody, code: string) => b.elements.find((e) => e.id === T.indicator(code))!;
  await expectReject(svc, v2(v1, (b) => (typeOf(b, "hostname").props["format"] = "число")), "content");
  await expectReject(svc, v2(v1, (b) => (typeOf(b, "os_distro").props["format"] = "перечень:nope")), "content");
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("ip"), "value", "not-an-ip", "не адрес"])), "content");
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("username"), "value", "V", "повтор «v»"])), "content");
});

test("T217, DATA-23: второй шаблон того же Класса и подтипа — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => b.templates.push(structuredClone(b.templates[0]!))), "content");
});

test("T232, DICT-12: две склейки одного местного типа в разные каноны — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const localId = "0190a000-0000-7000-8000-00000000eeee";
  await expectReject(
    svc,
    v2(v1, (b) => b.merges.push({ local: "A:x", localId, canonical: T.indicator("username") }, { local: "A:x", localId, canonical: T.indicator("hostname") })),
    "content",
  );
});

test("T247, DICT-10: список Стоп-листа под прежним Кодом с другим Идентификатором — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(
    svc,
    v2(v1, (b) => {
      const old = b.stopLists[0]!;
      b.stopLists.push({ ...structuredClone(old), id: "0190a000-0000-7000-8000-00000000f001" });
      old.code = "x_renamed";
    }),
    "content",
  );
});

test("T248, DATA-23: формат поля шаблона проверяется применением", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.templates[0]!.blocks[0]!.fields[0]!.format = "не формат")), "content");
  await expectReject(svc, v2(v1, (b) => (b.templates[0]!.blocks[0]!.fields[0]!.format = "перечень:nope")), "content");
});

test("T258, DICT-41: шаблон строки Сети, не совпадающий ни с одним нормализованным значением, — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("hostname"), "pattern", "OrangePi*", "x"])), "content");
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("domain"), "pattern", "*.Example.test", "x"], [T.indicator("domain"), "pattern", "*.example.test", "x"])), "content");
});

test("T259, DICT-10: смена Кода значения перечня без синонима прежнего Кода — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const { EV } = await import("../../support/dictionary.ts");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === EV("os_distro", "debian"))!.code = "debian_gnu")), "content");
});

test("T265, DICT-10: синоним прежнего Кода значения не пропадает следующей версией — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const { EV } = await import("../../support/dictionary.ts");
  const second = v2(v1, (b) => {
    b.elements.find((e) => e.id === EV("os_distro", "debian"))!.code = "debian_gnu";
    b.elements.find((e) => e.id === T.enumOf("os_distro"))!.props["aliases"] = { debian: "debian_gnu" };
  });
  assert.equal((await submit(svc, second)).statusCode, 201);
  await expectReject(svc, signWithTestCoordinator(nextTestVersion(second, (b) => delete b.elements.find((e) => e.id === T.enumOf("os_distro"))!.props["aliases"])), "content");
});

test("T278, приложение §8: значение строки Стоп-листа Сети не по формату типа — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("domain"), "value", "localhost", "x"])), "content");
  await expectReject(svc, v2(v1, (b) => b.stopLists[0]!.rows.push([T.indicator("file_sha256"), "value", "ab", "x"])), "content");
});

test("T300, DICT-60: closed: true у перечня не поля программы — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.enumOf("os_distro"))!.props["closed"] = true)), "content");
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.enumOf("geo_precision"))!.props["closed"] = true)), "content");
});

test("T301, NET-54: отказ и конфликт на API сопровождения — от владельца проверенного ключа подписи", async (t) => {
  const { testCoordinatorKey } = await import("../../support/harness.ts");
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  const owner = String(svc.db.prepare("SELECT memberId FROM coordinator_key WHERE state = 'registered'").get()?.["memberId"]);
  const actorOf = (action: string) => svc.db.prepare("SELECT actorId FROM journal WHERE action = ? ORDER BY seq DESC LIMIT 1").get(action)?.["actorId"];
  await expectReject(svc, v2(v1, (b) => b.programRequirements.normClasses.push("имя-хоста/2")), "unsupported");
  assert.equal(actorOf("dictionary.reject"), owner, "unsupported — от владельца ключа");
  const other = signWithTestCoordinator({ format: SLOVAR_FORMAT, body: JSON.stringify({ ...JSON.parse(v1.body), issuedAt: "2026-10-19T11:00:00.000Z" }), signatures: [] }, testCoordinatorKey(0x22));
  const conflict = signWithTestCoordinator(other);
  await expectReject(svc, conflict, "conflict");
  assert.equal(actorOf("dictionary.conflict"), owner, "первая подпись — чужим ключом; автор — владелец проверенного");
});

test("T304, DICT-60: тип Индикатора Сети с перечнем поля программы — content", async (t) => {
  const svc = await startTestService(t);
  const v1 = await applyTestDictionary(svc);
  await expectReject(svc, v2(v1, (b) => (b.elements.find((e) => e.id === T.indicator("hw_model"))!.props["format"] = "перечень:case_shape")), "content");
});
