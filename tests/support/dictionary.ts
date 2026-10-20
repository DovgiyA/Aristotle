// Малый синтетический Словарь Сети стенда (research R18 фичи 005): по типу Индикатора на каждый Класс
// нормализации, опознающие строгий и нестрогий, тип с автоматическим Секретом, перечни открытый и
// закрытый, Классы изделий с шаблонами, Стоп-лист со строкой каждого вида. Тело собирается прямо по
// схеме `protocol`, без сборки версии ядра. Значения условные (принцип VII).
import { SLOVAR_FORMAT, MATERIAL_KINDS, bodySha256, type SignedDocument, type SlovarBody, type SlovarElement, type TemplateField } from "@aristotel/protocol";
import { callAs, callMaintenance, launchTestNetwork, signDocument, testCoordinatorKey, type TestCoordinatorKey, type TestService } from "./harness.ts";

let counter = 0;
const ids = new Map<string, string>();

/** Детерминированный Идентификатор элемента по ключу «вид:Код» — один и тот же во всех версиях стенда. */
export function tid(key: string): string {
  let id = ids.get(key);
  if (id === undefined) {
    counter++;
    id = `0190a000-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`;
    ids.set(key, id);
  }
  return id;
}

const el = (kind: SlovarElement["kind"], code: string, label: string, props: Record<string, unknown>, extra: Partial<SlovarElement> = {}): SlovarElement => ({
  id: tid(`${kind}:${code}`),
  code,
  label,
  kind,
  state: "active",
  sinceVersion: 1,
  props,
  ...extra,
});

const OT = (code: string) => tid(`object_type:${code}`);
const IT = (code: string) => tid(`indicator_type:${code}`);
const EN = (code: string) => tid(`enum:${code}`);
export const EV = (enumCode: string, code: string) => tid(`enum_value:${enumCode}.${code}`);
const LT = (code: string) => tid(`link_type:${code}`);

/** Идентификаторы элементов стенда по Коду. */
export const T = { object: OT, indicator: IT, enumOf: EN, value: EV, link: LT };

function enumWith(code: string, closed: boolean, values: [string, string][]): SlovarElement[] {
  return [
    el("enum", code, code, { closed }),
    ...values.map(([v, label]) => ({ ...el("enum_value", v, label, { enum: EN(code) }), id: EV(code, v) })),
  ];
}

const indicator = (code: string, label: string, object: string, format: string, normClass: string | null, identifying: "strict" | "loose" | "none", extra: Record<string, unknown> = {}) =>
  el("indicator_type", code, label, { object: OT(object), format, comparable: normClass !== null && identifying !== "none" ? true : extra["comparable"] === true, normClass, identifying, autoSecret: false, ...extra });

export function testElements(): SlovarElement[] {
  return [
    el("object_type", "operator", "Оператор", { role: "node", identifying: [IT("username"), IT("callsign")] }),
    el("object_type", "build_station", "Станция сборки", { role: "node", identifying: [IT("win_volume_guid")] }),
    el("object_type", "key", "Ключ", { role: "node", identifying: [IT("ssh_fingerprint")] }),
    el("object_type", "infra_node", "Инфраструктурный узел", { role: "node", identifying: [IT("domain"), IT("ip")] }),
    el("object_type", "radio", "Радио/Канал связи", { role: "node", identifying: [IT("wfb_link_id")] }),
    el("object_type", "hw_element", "Аппаратный элемент", { role: "node", identifying: [IT("serial")] }),
    el("object_type", "artifact", "Артефакт", { role: "node", identifying: [IT("file_sha256")] }),
    el("object_type", "geo_object", "Гео-объект", { role: "node" }),
    el("object_type", "platform", "Платформа/ОС", { role: "part" }),
    el("object_type", "flight_profile", "Полётный профиль", { role: "part" }),
    indicator("username", "Учётная запись", "operator", "строка:64", "строка-без-регистра", "loose", { crossCompare: [IT("callsign")] }),
    indicator("callsign", "Позывной", "operator", "строка:64", "строка-без-регистра", "loose", { crossCompare: [IT("username")] }),
    indicator("win_volume_guid", "GUID тома Windows", "build_station", "guid", "guid", "strict"),
    indicator("ssh_fingerprint", "Отпечаток SSH", "key", "ssh-ключ", "ssh-ключ", "strict"),
    indicator("domain", "Домен", "infra_node", "домен", "домен", "strict"),
    indicator("ip", "IP-адрес", "infra_node", "ip", "ip", "strict"),
    indicator("wfb_link_id", "WFB link_id", "radio", "целое", "целое", "loose"),
    indicator("serial", "Серийный номер", "hw_element", "серийный", "серийный", "loose"),
    indicator("hw_model", "Модель", "hw_element", "строка:96", null, "none"),
    indicator("hw_kind", "Вид элемента", "hw_element", "перечень:hw_kind", null, "none"),
    indicator("file_sha256", "SHA-256 файла", "artifact", "hex:64", "hex", "strict"),
    indicator("hostname", "Имя хоста", "platform", "имя хоста", "имя-хоста", "none", { comparable: true }),
    indicator("os_note", "Заметка об ОС", "platform", "строка:64", "строка", "none"),
    indicator("os_distro", "Дистрибутив", "platform", "перечень:os_distro", null, "none"),
    indicator("fs_type", "Файловая система", "platform", "перечень:fs_type ×N", null, "none"),
    indicator("recovered_password", "Восстановленный пароль", "platform", "строка:128", "строка", "none", { autoSecret: true }),
    indicator("ap_param", "Параметр автопилота", "flight_profile", "параметр", null, "none"),
    indicator("timezone", "Часовой пояс", "platform", "перечень:timezone", null, "none"),
    indicator("country", "Страна", "platform", "перечень:country", null, "none"),
    indicator("geo_shape", "Координаты, область", "geo_object", "гео", null, "none"),
    el("link_type", "built_on", "собрано_на", { from: ["@item"], to: [OT("build_station")], directed: true }),
    el("link_type", "authored_by", "авторства", { from: ["@item", OT("flight_profile")], to: [OT("operator")], directed: true }),
    el("link_type", "uses_key", "использует_ключ", { from: ["@item"], to: [OT("key")], directed: true }),
    el("link_type", "controlled_via", "управляется_через", { from: ["@item"], to: [OT("infra_node")], directed: true }),
    el("link_type", "links_via", "связь_по", { from: ["@item"], to: [OT("radio")], directed: true }),
    el("link_type", "has_element", "содержит_элемент", { from: ["@item"], to: [OT("hw_element")], directed: true }),
    el("link_type", "has_profile", "связан_с_профилем", { from: ["@item"], to: [OT("flight_profile")], directed: true }),
    el("link_type", "same_airframe", "один_борт", { from: ["@item"], to: ["@item"], directed: false }),
    el("link_type", "connected_to", "соединено_с", { from: ["@item"], to: ["@item"], directed: false }),
    el("link_type", "supported_by", "подтверждается", { from: ["@link"], to: [OT("artifact"), "@material"], directed: true }),
    ...enumWith("item_class", true, [
      ["companion", "companion-компьютер"],
      ["flight_controller", "полётный контроллер"],
      ["radio_module", "радиомодуль"],
    ]),
    ...enumWith("item_subtype", true, [["bare_media", "голый носитель"]]),
    ...enumWith("case_shape", true, [
      ["airframe", "Борт"],
      ["single_item", "отдельное Изделие"],
    ]),
    ...enumWith("acquisition_method", true, [
      ["physical_ro", "побайтовый образ только на чтение"],
      ["logical", "логическая копия"],
    ]),
    ...enumWith("extraction_status", true, [
      ["full", "полное"],
      ["partial", "частичное"],
    ]),
    ...enumWith("material_kind", true, MATERIAL_KINDS.map((k) => [k, k] as [string, string])),
    ...enumWith("os_distro", false, [
      ["debian", "Debian"],
      ["ubuntu", "Ubuntu"],
    ]),
    ...enumWith("fs_type", false, [
      ["ext4", "ext4"],
      ["vfat", "vfat"],
    ]),
    ...enumWith("hw_kind", false, [
      ["storage", "носитель"],
      ["sbc", "одноплатный компьютер"],
    ]),
    // Перечни по внешним стандартам: Коды — идентификаторы стандарта (DICT-63).
    { ...el("enum", "timezone", "timezone", { closed: false, aliases: { "Europe/Kiev": "Europe/Kyiv" } }) },
    { ...el("enum_value", "Europe/Kyiv", "Europe/Kyiv", { enum: EN("timezone") }), id: EV("timezone", "Europe/Kyiv") },
    ...enumWith("country", false, [
      ["UA", "Ukraine"],
      ["00", "00"],
    ]),
    // Открытый, как в Словаре Сети (приложение §7; T148).
    ...enumWith("geo_precision", false, [
      ["point", "точка"],
      ["km_1", "до 1 км"],
      ["km_10", "до 10 км"],
      ["district", "район"],
      ["region", "область"],
    ]),
  ];
}

const f = (label: string, required: boolean, defaultSource: "auto" | "manual", target: TemplateField["target"], format?: string): TemplateField => ({
  label,
  required,
  defaultSource,
  target,
  ...(format === undefined ? {} : { format }),
});

const HEADER = {
  block: "header" as const,
  fields: [
    f("Класс изделия, подтип", true, "manual", { programField: "itemClass" }),
    f("Аппаратная платформа", true, "auto", { objectKind: OT("hw_element"), indicatorTypes: [IT("hw_kind"), IT("hw_model")], link: LT("has_element") }),
    f("Серийные номера", false, "auto", { objectKind: OT("hw_element"), indicatorTypes: [IT("serial")], link: LT("has_element") }),
  ],
};
const MEDIA = {
  block: "media" as const,
  fields: [
    f("Носитель", false, "manual", { objectKind: OT("hw_element"), indicatorTypes: [IT("serial")], link: LT("has_element") }),
    f("Способ снятия", true, "manual", { programField: "acquisitionMethod" }),
  ],
};
const OS = {
  block: "os" as const,
  fields: [
    f("Имя хоста", true, "auto", { objectKind: OT("platform"), indicatorTypes: [IT("hostname")] }, "имя хоста"),
    f("Дистрибутив", true, "auto", { objectKind: OT("platform"), indicatorTypes: [IT("os_distro")] }),
  ],
};

export function testTemplates(): SlovarBody["templates"] {
  return [
    {
      class: EV("item_class", "companion"),
      blocks: [HEADER, MEDIA, OS, { block: "class", fields: [f("Учётка оператора", true, "auto", { objectKind: OT("operator"), indicatorTypes: [IT("username")], link: LT("authored_by") })] }],
    },
    {
      class: EV("item_class", "flight_controller"),
      blocks: [HEADER, MEDIA, { block: "class", fields: [f("Параметры автопилота", false, "auto", { objectKind: OT("flight_profile"), indicatorTypes: [IT("ap_param")], link: LT("has_profile") })] }],
    },
    {
      class: EV("item_class", "flight_controller"),
      subtype: EV("item_subtype", "bare_media"),
      blocks: [HEADER, MEDIA, { block: "class", fields: [f("Параметры автопилота", false, "auto", { objectKind: OT("flight_profile"), indicatorTypes: [IT("ap_param")], link: LT("has_profile") })] }],
    },
    {
      class: EV("item_class", "radio_module"),
      blocks: [HEADER, MEDIA, OS, { block: "class", fields: [f("link_id", false, "auto", { objectKind: OT("radio"), indicatorTypes: [IT("wfb_link_id")], link: LT("links_via") })] }],
    },
  ];
}

export function testStopLists(): SlovarBody["stopLists"] {
  return [
    {
      id: tid("stop_list:common_defaults"),
      code: "common_defaults",
      label: "Общие умолчания",
      source: "нет, правится вручную",
      builtAt: "2026-10-13",
      rows: [
        [IT("username"), "value", "v", "учётка по умолчанию"],
        [IT("hostname"), "pattern", "orangepi*", "имя хоста по умолчанию образа платы"],
        [IT("ip"), "range", "10.0.0.0/8", "частный адрес"],
      ],
    },
  ];
}

export interface TestBodyOptions {
  number?: number;
  previousSha256?: string | null;
  /** Правка тела перед сериализацией — для следующих версий и тестов отказов. */
  change?: (body: SlovarBody) => void;
}

export function testDictionaryBody(options: TestBodyOptions = {}): SlovarBody {
  const number = options.number ?? 1;
  const body: SlovarBody = {
    number,
    issuedAt: "2026-10-19T10:00:00.000Z",
    previousSha256: options.previousSha256 ?? null,
    programRequirements: { normClasses: ["строка", "строка-без-регистра", "имя-хоста", "домен", "hex", "guid", "ip", "ssh-ключ", "серийный", "целое"], materialKinds: [...MATERIAL_KINDS] },
    elements: testElements(),
    templates: testTemplates(),
    stopLists: testStopLists(),
    merges: [],
  };
  options.change?.(body);
  return body;
}

/** Неподписанный документ версии. */
export function testDictionaryDocument(options: TestBodyOptions = {}): SignedDocument {
  return { format: SLOVAR_FORMAT, body: JSON.stringify(testDictionaryBody(options)), signatures: [] };
}

/** Ключ Координатора стенда — тот же, что у launchTestNetwork по умолчанию. */
export const TEST_COORDINATOR_SEED = 0x11;

export function signWithTestCoordinator(doc: SignedDocument, key: TestCoordinatorKey = testCoordinatorKey(TEST_COORDINATOR_SEED)): SignedDocument {
  return signDocument(doc, key);
}

/** Следующая версия стенда поверх тела предыдущей: номер + 1, previousSha256 — тождество предыдущей. */
export function nextTestVersion(previous: SignedDocument, change: (body: SlovarBody) => void): SignedDocument {
  const prev = JSON.parse(previous.body) as SlovarBody;
  const body: SlovarBody = { ...structuredClone(prev), number: prev.number + 1, previousSha256: bodySha256(previous.body), merges: [] };
  change(body);
  return { format: SLOVAR_FORMAT, body: JSON.stringify(body), signatures: [] };
}

/**
 * Применить версию стенда через API сопровождения (T036): Сеть стенда запускается, если ещё нет
 * Реестра; версия подписывается Ключом Координатора стенда. Возвращает поданный документ.
 */
export async function applyTestDictionary(svc: TestService, doc?: SignedDocument): Promise<SignedDocument> {
  if (svc.db.prepare("SELECT 1 AS x FROM registry_version LIMIT 1").get() === undefined) launchTestNetwork(svc, undefined, TEST_COORDINATOR_SEED);
  const signed = doc ?? signWithTestCoordinator(testDictionaryDocument());
  const res = await callMaintenance(svc, "POST", "/api/dictionary/versions", signed);
  if (res.statusCode !== 201 && res.statusCode !== 200) throw new Error(`версия Словаря стенда не применена: ${res.statusCode} ${res.body}`);
  return signed;
}

/** Создать Кейс через API Станций от имени Члена Группы; вернуть Запись. */
export async function createTestCase(svc: TestService, memberId: string, fields: Record<string, unknown> = {}): Promise<{ id: string; fields: Record<string, unknown>; version: number; view?: Record<string, unknown> }> {
  const res = await callAs(svc, memberId, "POST", "/api/records", { type: "case", fields: { shape: EV("case_shape", "single_item"), ...fields } });
  if (res.statusCode !== 201) throw new Error(`Кейс стенда не создан: ${res.statusCode} ${res.body}`);
  return res.json();
}

/** Создать Изделие Кейса. */
export async function createTestItem(svc: TestService, memberId: string, caseId: string, itemClass = "companion", extra: Record<string, unknown> = {}): Promise<{ id: string; fields: Record<string, unknown>; version: number }> {
  const res = await callAs(svc, memberId, "POST", "/api/records", { type: "item", fields: { case: caseId, itemClass: EV("item_class", itemClass), ...extra } });
  if (res.statusCode !== 201) throw new Error(`Изделие стенда не создано: ${res.statusCode} ${res.body}`);
  return res.json();
}

/** Создать объект онтологии. */
export async function createTestObject(svc: TestService, memberId: string, kind: string, fields: Record<string, unknown>): Promise<{ id: string; fields: Record<string, unknown>; version: number }> {
  const res = await callAs(svc, memberId, "POST", "/api/records", { type: "object", fields: { kind: T.object(kind), ...fields } });
  if (res.statusCode !== 201) throw new Error(`объект стенда не создан: ${res.statusCode} ${res.body}`);
  return res.json();
}

/** Создать Индикатор; вернуть ответ целиком (статус проверяет тест). */
/**
 * Создать Индикатор; вернуть ответ целиком (статус проверяет тест). Без `case` в value стенд
 * передаёт Кейс узла явно — как интерфейс с Карточки этого Кейса (DATA-36); правило R1 по умолчанию
 * проверяют тесты, которые зовут API напрямую.
 */
export async function postIndicator(svc: TestService, memberId: string, object: string, type: string, value: Record<string, unknown>) {
  const fields: Record<string, unknown> = { object, type: T.indicator(type), source: { kind: "manual" }, ...value };
  if (fields["case"] === undefined) {
    const obj = svc.db.prepare("SELECT type, fields FROM record WHERE id = ?").get(object);
    const parsed = obj === undefined ? {} : (JSON.parse(String(obj["fields"])) as Record<string, unknown>);
    if (obj !== undefined && obj["type"] === "object" && parsed["item"] === undefined) fields["case"] = parsed["case"];
  }
  return await callAs(svc, memberId, "POST", "/api/records", { type: "indicator", fields });
}

/** Предложить в Местное расширение и (если decide) принять Старшим стенда. */
export async function proposeLocal(svc: TestService, memberId: string, kind: string, payload: Record<string, unknown>, decide = true) {
  const p = await callAs(svc, memberId, "POST", "/api/local-extension/proposals", { kind, payload });
  if (!decide || p.statusCode !== 201) return p;
  return await callAs(svc, svc.seniorId, "POST", `/api/local-extension/proposals/${p.json().id}/accept`, {});
}
