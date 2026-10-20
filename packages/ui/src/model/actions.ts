// Какие действия показать роли — по той же таблице прав, по которой Опорная станция их проверяет
// (FR-018; research R15 фичи 004); признак присутствия — где интерфейс заранее спросит пароль (STATION-12).
import { isAllowed, needsPresence, type Action, type Role } from "@aristotel/protocol/browser";

export interface Actions {
  members: { create: boolean; update: boolean; revoke: boolean };
  stations: { view: boolean; revoke: boolean };
  invitations: { view: boolean; issue: boolean; cancel: boolean };
  registry: { draft: boolean; apply: boolean };
  dictionary: { apply: boolean };
}

export function actionsFor(role: Role): Actions {
  const can = (action: Action) => isAllowed(role, action);
  return {
    members: { create: can("member.create"), update: can("member.update"), revoke: can("member.revoke") },
    stations: { view: can("station.read"), revoke: can("station.revoke") },
    invitations: { view: can("invitation.read"), issue: can("invitation.issue"), cancel: can("invitation.cancel") },
    registry: { draft: can("registry.draft"), apply: can("registry.apply") },
    dictionary: { apply: can("dictionary.apply") },
  };
}

export { needsPresence };
