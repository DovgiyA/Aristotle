// T061 фичи 004 — виды интерфейса: действия по роли из таблицы прав, подписи из файла локализации,
// фильтры журнала, отпечатки восьмью группами hex, экраны входа и присутствия (APP-09, APP-27,
// ROLE-37, NET-42, INBOX-32, FR-018, FR-019).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { message, tlsSpkiGroups } from "@aristotel/protocol";
import { actionsFor } from "../src/model/actions.ts";
import { actionsIn, journalQuery } from "../src/model/journal.ts";
import { JOURNAL_ACTIONS } from "@aristotel/protocol";
import { MembersView } from "../src/views/members.ts";
import { InvitationsView } from "../src/views/invitations.ts";
import { JournalView } from "../src/views/journal.ts";
import { RegistryView, spkiGroups } from "../src/views/registry.ts";
import { stationStateText } from "../src/views/stations.ts";
import { AcceptScreen, ConnectionBanner, PresenceDialog, UnlockScreen } from "../src/views/screens.ts";

const render = (node: unknown) => renderToString(node as ReactElement);
const member = (label: string, role: "participant" | "senior" | "observer") => ({ id: label, label, role, state: "active" as const, version: 1, createdAt: "t" });

test("actionsFor: Участнику и Наблюдателю нет действий Старшего", () => {
  for (const role of ["participant", "observer"] as const) {
    const a = actionsFor(role);
    assert.deepEqual([a.members.create, a.stations.view, a.invitations.issue, a.registry.apply], [false, false, false, false], role);
  }
  const s = actionsFor("senior");
  assert.deepEqual([s.members.create, s.stations.revoke, s.invitations.cancel, s.registry.apply], [true, true, true, true]);
});

test("состав Группы: подписи из локализации, кнопки — только Старшему", () => {
  const members = [member("С1", "senior"), member("У1", "participant")];
  const senior = render(MembersView({ role: "senior", members }));
  assert.match(senior, new RegExp(message("ui.members.add")));
  assert.match(senior, /Старший/);
  assert.match(senior, new RegExp(message("ui.members.revoke_warning")));
  assert.doesNotMatch(render(MembersView({ role: "participant", members })), /data-action/);
});

test("Приглашения: строка — один раз; Участнику вида нет", () => {
  const invitations = [{ id: "i", memberId: "u", memberLabel: "У3", issuedBy: null, issuedAt: "t", expiresAt: "2026-10-21", view: "issued" as const }];
  const html = render(InvitationsView({ role: "senior", invitations, fresh: "aristotel-priglashenie-v1:xyz" }));
  assert.match(html, /aristotel-priglashenie-v1:xyz/);
  assert.match(html, /выпущено/);
  assert.equal(render(InvitationsView({ role: "participant", invitations }) ?? ""), "");
});

test("Журнал: фильтры по Члену Группы и виду действия", () => {
  assert.equal(journalQuery({ member: "m", action: "record.create" }), "/api/journal?member=m&action=record.create&limit=200");
  assert.equal(journalQuery({}), "/api/journal?limit=200");
  const items = [
    { seq: 1, at: "t", actorId: "m", actorLabel: "С1", action: "record.create", subjectType: "record", subjectId: "r", details: null },
    { seq: null, at: "t", actorId: null, actorLabel: "служба Опорной станции", action: "group-key.create", subjectType: "group-key", subjectId: "k", details: null },
  ];
  assert.deepEqual(actionsIn(items as never), ["group-key.create", "record.create"]);
  const html = render(JournalView({ items: items as never, members: [member("С1", "senior")], filters: {} }));
  assert.match(html, new RegExp(message("ui.journal.member")));
  assert.match(html, /служба Опорной станции/);
});

test("Реестр: отпечатки восьмью группами hex совпадают с CLI (FR-019); подпись — Старшему", () => {
  const spki = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";
  assert.equal(spkiGroups(spki), tlsSpkiGroups(spki));
  const registry = { number: 3, code: "A", relays: [{ url: "https://relay-x.test", tlsSpki: spki }], coordinatorKeyFingerprints: ["a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90"] };
  const props = { registry, groupKeyFingerprint: "1111 2222 3333 4444 5555 6666 7777 8888", baseTlsGroups: spkiGroups(spki), stationKeyFingerprint: null, connected: { "https://relay-x.test": true } };
  const html = render(RegistryView({ role: "observer", ...props }));
  assert.match(html, /a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90/);
  assert.match(html, new RegExp(tlsSpkiGroups(spki)));
  assert.match(html, /на связи/);
  assert.doesNotMatch(html, /registry\.apply/);
  assert.match(render(RegistryView({ role: "senior", ...props })), /data-action="registry\.apply"/);
  assert.match(render(RegistryView({ role: "senior", ...props, registry: null })), new RegExp(message("ui.registry.none")));
});

test("экраны: приём, вход, блокировка, присутствие, связь — строки из локализации", () => {
  assert.match(render(AcceptScreen({ error: null })), new RegExp(message("ui.accept.submit")));
  assert.match(render(UnlockScreen({ locked: true, error: null })), new RegExp(message("ui.unlock.locked")));
  assert.match(render(PresenceDialog({ error: "x" })), new RegExp(message("ui.presence.text")));
  assert.match(render(ConnectionBanner({ offlineSince: "2026-10-18T10:00:00.000Z", tlsMismatch: null, updateRequired: false })), /Нет связи с Опорной станцией/);
  assert.equal(render(ConnectionBanner({ offlineSince: null, tlsMismatch: null, updateRequired: false }) ?? ""), "");
});

test("формы вместо диалогов браузера: заведение с подписью и ролью, Приглашение — выбор из действующих", () => {
  const members = [member("С1", "senior"), member("У1", "participant"), { ...member("У9", "participant"), state: "revoked" as const }];
  const add = render(MembersView({ role: "senior", members }));
  assert.match(add, /data-form="member\.create"/);
  assert.match(add, /name="label"/);
  assert.match(add, /<option value="observer">Наблюдатель<\/option>/);
  assert.match(add, /data-action="member\.update"/);
  const inv = render(InvitationsView({ role: "senior", invitations: [], members }));
  assert.match(inv, /data-form="invitation\.issue"/);
  assert.match(inv, /<option value="У1">У1<\/option>/);
  assert.doesNotMatch(inv, /У9/, "отозванному Приглашение не выпускают");
});

test("Реестр: форма подписи Старшему — файл ключа и два пароля (US4.9); без Реестра формы нет", () => {
  const registry = { number: 1, code: "A", relays: [], coordinatorKeyFingerprints: [] };
  const props = { registry, groupKeyFingerprint: null, baseTlsGroups: null, stationKeyFingerprint: null, connected: {} };
  const html = render(RegistryView({ role: "senior", ...props }));
  assert.match(html, /data-form="registry\.apply"/);
  assert.match(html, /<input type="file"[^>]*name="keyFile"/);
  assert.equal(html.match(/type="password"/g)?.length, 2);
  assert.doesNotMatch(render(RegistryView({ role: "senior", ...props, registry: null })), /data-form/);
});

test("Журнал по страницам: курсор продолжения в запросе, «Показать ещё» при курсоре; виды действий — весь словарь", () => {
  assert.equal(journalQuery({ member: "m" }, 200, "c1"), "/api/journal?member=m&limit=200&cursor=c1");
  const items = [{ seq: 1, at: "t", actorId: "m", actorLabel: "С1", action: "record.create", subjectType: "record", subjectId: "r", details: null }];
  const more = render(JournalView({ items: items as never, members: [], filters: {}, cursor: "c1" }));
  assert.match(more, /data-action="journal\.more"/);
  assert.doesNotMatch(render(JournalView({ items: items as never, members: [], filters: {}, cursor: null })), /journal\.more/);
  // Вид действия, которого нет на показанной странице, всё равно можно выбрать.
  assert.match(more, /<option value="station\.revoke">/);
  assert.ok(JOURNAL_ACTIONS.includes("record.create"));
});

test("Журнал: у каждого вида действия есть подпись в локализации; таблица и фильтр — подписи, а не коды (APP-09)", () => {
  for (const action of JOURNAL_ACTIONS) assert.notEqual(message(`ui.journal.action.${action}` as never), `ui.journal.action.${action}`, action);
  const items = [{ seq: 1, at: "t", actorId: "m", actorLabel: "С1", action: "record.create", subjectType: "record", subjectId: "r", details: null }];
  const html = render(JournalView({ items: items as never, members: [], filters: {} }));
  assert.match(html, new RegExp(`<td>${message("ui.journal.action.record.create" as never)}</td>`));
  assert.match(html, new RegExp(`<option value="station.revoke">${message("ui.journal.action.station.revoke" as never)}</option>`));
});

test("Журнал: приём Станции — «Станция принята» с отпечатком её ключа (FR-008, US2/AC2)", () => {
  const items = [{ seq: 7, at: "t", actorId: "m", actorLabel: "С1", action: "station.accept", subjectType: "station", subjectId: "s1", details: { invitationId: "i", keyFingerprint: "a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90" } }];
  const html = render(JournalView({ items: items as never, members: [], filters: {} }));
  assert.match(html, /Станция принята/);
  assert.match(html, /a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90/);
});

test("Станции: «только удаление» — оставшийся срок в днях и дата (US5/AC6, VIEW-47)", () => {
  const now = Date.parse("2026-10-19T00:00:00.000Z");
  const station = { view: "delete-only", deleteOnlyUntil: "2026-10-29T12:00:00.000Z" } as never;
  assert.equal(stationStateText(station, now), "только удаление: осталось 11 дн., до 2026-10-29T12:00:00.000Z");
});

test("Журнал: вид действия вне словаря — показывается кодом, вид не падает", () => {
  const items = [{ seq: 1, at: "t", actorId: null, actorLabel: "служба", action: "future.kind", subjectType: "x", subjectId: "y", details: null }];
  assert.match(render(JournalView({ items: items as never, members: [], filters: {} })), /<td>future\.kind<\/td>/);
});

test("Реестр: заголовки таблицы Ретрансляторов — строки локализации (APP-09, конституция VIII)", () => {
  const registry = { number: 1, code: "A", relays: [{ url: "https://relay-x.test", tlsSpki: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk" }], coordinatorKeyFingerprints: [] };
  const html = render(RegistryView({ role: "observer", registry, groupKeyFingerprint: null, baseTlsGroups: null, stationKeyFingerprint: null, connected: {} }));
  assert.match(html, new RegExp(`<th>${message("ui.registry.url" as never)}</th><th>${message("ui.registry.tls" as never)}</th>`));
});
