// Интерфейс Станции в браузере на 127.0.0.1 (APP-27): состояние локальной части решает экран — приём,
// вход и разблокировка, работа с видами; диалог подтверждения присутствия (STATION-12).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  InvitationView,
  InvitationsResponse,
  IssueInvitationResponse,
  JournalItem,
  JournalResponse,
  LocalState,
  Member,
  MembersResponse,
  Role,
  StationView,
  StationsResponse,
} from "@aristotel/protocol/browser";
// Типы ответов Сети — из полного входа protocol: только типы, в сборку интерфейса node:* не попадает.
import type { DictionaryCurrent, DictionaryState, GroupKeyInfo, RegistryState } from "@aristotel/protocol";
import { h } from "./h.ts";
import { t } from "./strings.ts";
import { ApiFailure, LocalApi, LockedError } from "./api.ts";
import { journalQuery, type JournalFilters } from "./model/journal.ts";
import { actionsFor } from "./model/actions.ts";
import { MembersView } from "./views/members.ts";
import { StationsView } from "./views/stations.ts";
import { InvitationsView } from "./views/invitations.ts";
import { JournalView } from "./views/journal.ts";
import { RegistryView, spkiGroups, type RegistryInfo } from "./views/registry.ts";
import { signAndApply } from "./model/registry-sign.ts";
import { DictionaryView } from "./views/dictionary.ts";
import { signAndApplyDictionary } from "./model/dictionary-sign.ts";
import { contentVisible, watchState } from "./model/lock.ts";
import { AcceptScreen, ConnectionBanner, PresenceDialog, UnlockScreen } from "./views/screens.ts";


type Tab = "members" | "stations" | "invitations" | "journal" | "registry" | "dictionary";

let pendingPresence: ((password: string | null) => void) | null = null;
/** Диалог присутствия: закрыт, открыт или открыт снова после неверного пароля. */
type PresenceState = "closed" | "open" | "wrong";
let showPresence: (state: PresenceState) => void = () => undefined;

const api = new LocalApi(
  (retry) =>
    new Promise((resolve) => {
      pendingPresence = resolve;
      showPresence(retry ? "wrong" : "open");
    }),
);

function App(): ReactNode {
  const [state, setState] = useState<LocalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("members");
  const [presenceState, setPresenceState] = useState<PresenceState>("closed");
  const [members, setMembers] = useState<Member[]>([]);
  const [stations, setStations] = useState<StationView[]>([]);
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [journal, setJournal] = useState<JournalItem[]>([]);
  const [filters, setFilters] = useState<JournalFilters>({});
  const [journalCursor, setJournalCursor] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RegistryInfo | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [dictionary, setDictionary] = useState<DictionaryCurrent | null>(null);
  showPresence = setPresenceState;

  const refreshState = useCallback(async () => {
    try {
      setState(await api.request<LocalState>("GET", "/local/state"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const load = useCallback(async (which: Tab) => {
    try {
      if (which === "members" || which === "journal" || which === "invitations") setMembers((await api.request<MembersResponse>("GET", "/api/members")).items);
      if (which === "stations") setStations((await api.request<StationsResponse>("GET", "/api/stations")).items);
      if (which === "invitations") setInvitations((await api.request<InvitationsResponse>("GET", "/api/invitations")).items);
      if (which === "journal") {
        const page = await api.request<JournalResponse>("GET", journalQuery(filters));
        setJournal(page.items);
        setJournalCursor(page.cursor);
      }
      if (which === "registry") {
        const reg = await api.request<RegistryState>("GET", "/api/registry");
        // Связь Проходов — как её видит Опорная станция (contracts/http-api.md «Реестр»).
        setConnected(Object.fromEntries((reg.relays ?? []).map((r) => [r.url, r.connected])));
        const own = reg.current?.body.groups[0];
        setRegistry(reg.current === null || own === undefined ? null : { number: reg.current.number, code: own.code, relays: own.relays, coordinatorKeyFingerprints: reg.current.coordinatorKeyFingerprints });
        setGroupKey((await api.request<GroupKeyInfo>("GET", "/api/group-key")).keyFingerprint);
      }
      if (which === "dictionary") setDictionary((await api.request<DictionaryState>("GET", "/api/dictionary")).current);
      setError(null);
    } catch (e) {
      if (e instanceof LockedError) await refreshState();
      else setError(e instanceof ApiFailure ? e.message : String(e));
    }
  }, [filters, refreshState]);

  useEffect(() => {
    void api.start().then(refreshState, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    const onActivity = () => api.activity();
    window.addEventListener("click", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("click", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [refreshState]);

  const visible = contentVisible(state);

  // Простой: локальная часть сообщает uiLocked — скрыть содержимое сразу, без действия человека (STATION-11).
  useEffect(() => watchState(() => api.request<LocalState>("GET", "/local/state"), setState), []);

  useEffect(() => {
    if (visible) return;
    setMembers([]);
    setStations([]);
    setInvitations([]);
    setFresh(null);
    setJournal([]);
    setJournalCursor(null);
    setRegistry(null);
    setDictionary(null);
  }, [visible]);

  useEffect(() => {
    if (visible) void load(tab);
  }, [visible, tab, load]);

  const act = async (fn: () => Promise<unknown>, reload = true) => {
    try {
      await fn();
      if (reload) await load(tab);
    } catch (e) {
      // Заблокировано за время действия — экран разблокировки, а не текст ошибки.
      if (e instanceof LockedError) await refreshState();
      else setError(e instanceof Error ? e.message : String(e));
    }
  };

  const presence =
    presenceState === "closed"
      ? null
      : PresenceDialog({
          error: presenceState === "wrong" ? t("password_wrong") : null,
          onSubmit: (password) => {
            setPresenceState("closed");
            pendingPresence?.(password);
          },
          onCancel: () => {
            setPresenceState("closed");
            pendingPresence?.(null);
          },
        });

  if (state === null) return h("p", null, error ?? "…");
  if (!state.accepted)
    return AcceptScreen({
      error,
      onSubmit: (invitation, password, again) => {
        if (password !== again) return setError(t("ui.accept.mismatch"));
        void act(async () => setState(await api.request<LocalState>("POST", "/local/accept", { invitation, password })));
      },
    });
  if (!state.unlocked || state.uiLocked)
    return UnlockScreen({
      locked: state.uiLocked,
      error,
      onSubmit: (password) => void act(async () => setState(await api.request<LocalState>("POST", "/local/unlock", { password }))),
    });

  const role = state.role ?? "observer";
  const can = actionsFor(role);
  const tabs: Tab[] = ["members", ...(can.stations.view ? (["stations"] as Tab[]) : []), ...(can.invitations.view ? (["invitations"] as Tab[]) : []), "journal", "registry", "dictionary"];
  const body =
    tab === "members"
      ? MembersView({
          role,
          members,
          onAdd: (label, newRole) => void act(() => api.request("POST", "/api/members", { label, role: newRole })),
          onSetRole: (m, newRole) => void act(() => api.request("PATCH", `/api/members/${m.id}`, { expectedVersion: m.version, role: newRole })),
          onRevoke: (m) => void act(() => api.request("POST", `/api/members/${m.id}/revoke`, { expectedVersion: m.version })),
        })
      : tab === "stations"
        ? StationsView({ role, stations, onRevoke: (s, reason) => void act(() => api.request("POST", `/api/stations/${s.id}/revoke`, { reason })) })
        : tab === "invitations"
          ? InvitationsView({
              role,
              invitations,
              fresh,
              // Себе Приглашение не выпускают (invitation_self).
              members: members.filter((m) => m.id !== state.memberId),
              onIssue: (memberId) => void act(async () => setFresh((await api.request<IssueInvitationResponse>("POST", "/api/invitations", { memberId })).invitation)),
              onCancel: (i) => {
                setFresh(null);
                void act(() => api.request("POST", `/api/invitations/${i.id}/cancel`, {}));
              },
            })
          : tab === "journal"
            ? JournalView({
                items: journal,
                members,
                filters,
                onFilter: (f) => setFilters(f),
                cursor: journalCursor,
                // Следующая страница — к уже показанным (VIEW-59).
                onMore: () =>
                  void act(async () => {
                    const page = await api.request<JournalResponse>("GET", journalQuery(filters, 200, journalCursor));
                    setJournal((shown) => [...shown, ...page.items]);
                    setJournalCursor(page.cursor);
                  }, false),
              })
            : tab === "dictionary"
              ? DictionaryView({
                  role,
                  current: dictionary,
                  onSign: (input) =>
                    void act(async () => {
                      await signAndApplyDictionary(api, input);
                      await load("dictionary");
                    }),
                })
              : RegistryView({
                role,
                registry,
                groupKeyFingerprint: groupKey,
                baseTlsGroups: state.baseTlsSpki === null ? null : spkiGroups(state.baseTlsSpki),
                stationKeyFingerprint: state.stationKeyFingerprint,
                connected,
                onSign: (input) =>
                  void act(async () => {
                    if (registry === null) return;
                    await signAndApply(api, registry.code, input);
                  }),
              });
  return h(
    "div",
    { className: "app" },
    h("header", null, h("strong", null, t("ui.title")), h("span", null, ` · ${state.memberLabel ?? ""}`)),
    ConnectionBanner({ offlineSince: state.offlineSince, tlsMismatch: state.tlsMismatch, updateRequired: state.updateRequired }),
    h("nav", null, ...tabs.map((name) => h("button", { key: name, type: "button", className: name === tab ? "active" : "", onClick: () => {
              // Строка Приглашения показывается один раз — уходя с вида, её убираем.
              setFresh(null);
              setTab(name);
            } }, t(`ui.nav.${name}`)))),
    error === null ? null : h("p", { className: "error", role: "alert" }, t("ui.error", { text: error })),
    body,
    presence,
  );
}

const root = document.getElementById("app");
if (root !== null) createRoot(root).render(h(App));
