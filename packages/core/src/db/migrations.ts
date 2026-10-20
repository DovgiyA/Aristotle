// Схема Банка — один файл bank.sqlite (BANK-04); таблицы и правила — data-model.md фич 001 … 005.
// Новый Банк создаётся сразу схемой 5; Банк схемы 1 перестраивается миграцией 1 → 2 (research R5
// фичи 002), схемы 2 — миграцией 2 → 3 (research R11 фичи 003), схемы 3 — миграцией 3 → 4
// (research R18 фичи 004), схемы 4 — миграцией 4 → 5 (research R17 фичи 005).
import { message, type MessageCode } from "@aristotel/protocol";
import type { Db } from "./open.ts";
import { inTransaction } from "./open.ts";

const SCHEMA_VERSION = 6;

/** Текст сообщения для RAISE в триггере: кавычки SQL экранируются. */
function sqlMessage(code: MessageCode): string {
  return message(code).replaceAll("'", "''");
}

// Текст ошибки триггеров «только дописывается» (BANK-07).
const APPEND_ONLY = sqlMessage("append_only");
const APPEND_ONLY_NETWORK = sqlMessage("append_only_network");

// Таблица member схемы 1 (фича 001): только Старший, только «действует».
const MEMBER_V1 = `
CREATE TABLE member (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(label) > 0),
  role TEXT NOT NULL CHECK (role IN ('senior')),
  state TEXT NOT NULL CHECK (state IN ('active')),
  createdAt TEXT NOT NULL,
  bootstrap INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap IN (0, 1))
);`;

// Таблица member схемы 2 (фича 002): три роли, два состояния, номер версии (ROLE-03, ROLE-08; R7).
function memberV2(name: string): string {
  return `
CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(label) > 0),
  role TEXT NOT NULL CHECK (role IN ('participant', 'senior', 'observer')),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  createdAt TEXT NOT NULL,
  bootstrap INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap IN (0, 1))
);`;
}

// Журнал схем 1 и 2: автор — всегда Член Группы, предметы — Член Группы и Запись.
const JOURNAL_V1 = `
CREATE TABLE journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actorId TEXT NOT NULL REFERENCES member (id),
  action TEXT NOT NULL,
  subjectType TEXT NOT NULL CHECK (subjectType IN ('member', 'record')),
  subjectId TEXT NOT NULL,
  historyFrom INTEGER REFERENCES record_history (seq),
  historyTo INTEGER REFERENCES record_history (seq),
  details TEXT CHECK (details IS NULL OR json_valid(details))
);`;

// Журнал схемы 3 (фича 003): actorId = NULL — служба Опорной станции; предметы Сети (research R11).
function journalV3(name: string): string {
  return `
CREATE TABLE ${name} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actorId TEXT REFERENCES member (id),
  action TEXT NOT NULL,
  subjectType TEXT NOT NULL CHECK (subjectType IN ('member', 'record', 'group-key', 'registry', 'coordinator-key')),
  subjectId TEXT NOT NULL,
  historyFrom INTEGER REFERENCES record_history (seq),
  historyTo INTEGER REFERENCES record_history (seq),
  details TEXT CHECK (details IS NULL OR json_valid(details))
);`;
}

// Журнал схемы 4 (фича 004): предметы Станций, Приглашений, Ретрансляторов и параметров Группы.
function journalV4(name: string): string {
  return journalV3(name).replace(
    "'group-key', 'registry', 'coordinator-key')",
    "'group-key', 'registry', 'coordinator-key', 'station', 'invitation', 'relay', 'group-setting')",
  );
}

// Журнал схемы 5 (фича 005): предметы Словаря и Местного расширения, колонка Кейса (INBOX-32, DATA-36).
function journalV5(name: string): string {
  return journalV4(name)
    .replace("'relay', 'group-setting')", "'relay', 'group-setting', 'dictionary', 'local-extension')")
    .replace("details TEXT CHECK (details IS NULL OR json_valid(details))", "details TEXT CHECK (details IS NULL OR json_valid(details)),\n  caseId TEXT");
}

const JOURNAL_INDEXES = `
CREATE INDEX journal_actor ON journal (actorId, seq);
CREATE INDEX journal_subject ON journal (subjectId, seq);
CREATE INDEX journal_action ON journal (action, seq);
`;

const JOURNAL_TRIGGERS = `
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY}'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY}'); END;
`;

// Таблицы Банка вокруг member; member_one_bootstrap: первый Старший, заведённый при установке,
// ровно один (ROLE-26).
const bankTables = (member: string, journal: string = JOURNAL_V1): string => `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
${member}
CREATE UNIQUE INDEX member_one_bootstrap ON member (bootstrap) WHERE bootstrap = 1;

CREATE TABLE record (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  fields TEXT NOT NULL CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  createdBy TEXT NOT NULL REFERENCES member (id),
  updatedBy TEXT NOT NULL REFERENCES member (id)
);

CREATE TABLE record_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  recordId TEXT NOT NULL REFERENCES record (id),
  version INTEGER NOT NULL,
  field TEXT NOT NULL,
  before TEXT,
  after TEXT NOT NULL,
  authorId TEXT NOT NULL REFERENCES member (id),
  at TEXT NOT NULL
);
CREATE INDEX record_history_record ON record_history (recordId, seq);

${journal}
${JOURNAL_INDEXES}
CREATE VIRTUAL TABLE record_fts USING fts5(recordId UNINDEXED, text);

CREATE TRIGGER record_history_no_update BEFORE UPDATE ON record_history
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY}'); END;
CREATE TRIGGER record_history_no_delete BEFORE DELETE ON record_history
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY}'); END;
${JOURNAL_TRIGGERS}`;

const SCHEMA_V1 = bankTables(MEMBER_V1);

// Добавления схемы 2 поверх таблиц: триггеры пределов числа Старших (research R4) и метка Секрет у
// Записи (ROLE-24). Столбец secret добавляется и новому Банку — так порядок столбцов record один.
const V2_ADDITIONS = `
CREATE TRIGGER member_senior_bounds_insert AFTER INSERT ON member
  WHEN (SELECT count(*) FROM member WHERE role = 'senior' AND state = 'active') > 2
  BEGIN SELECT RAISE(ABORT, '${sqlMessage("senior_limit")}'); END;
CREATE TRIGGER member_senior_bounds_update AFTER UPDATE ON member
  BEGIN
    SELECT CASE
      WHEN n > 2 THEN RAISE(ABORT, '${sqlMessage("senior_limit")}')
      WHEN n = 0 THEN RAISE(ABORT, '${sqlMessage("last_senior")}')
    END FROM (SELECT count(*) AS n FROM member WHERE role = 'senior' AND state = 'active');
  END;

ALTER TABLE record ADD COLUMN secret INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0, 1));
`;


// Таблицы Сети схемы 3 (фича 003; data-model.md, research R3, R7, R10): открытые части Ключа Группы,
// Ключи Координатора с владельцами, применённые версии Реестра и развилки. Секретных частей здесь нет.
const V3_NETWORK = `
CREATE TABLE group_key (
  id TEXT PRIMARY KEY,
  signingKey TEXT NOT NULL,
  encryptionKey TEXT NOT NULL,
  keyFingerprint TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('install', 'upgrade', 'lost')),
  current INTEGER NOT NULL CHECK (current IN (0, 1))
);
CREATE UNIQUE INDEX group_key_one_current ON group_key (current) WHERE current = 1;
CREATE TRIGGER group_key_no_delete BEFORE DELETE ON group_key
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER group_key_only_current BEFORE UPDATE ON group_key
  WHEN NEW.id IS NOT OLD.id OR NEW.signingKey IS NOT OLD.signingKey OR NEW.encryptionKey IS NOT OLD.encryptionKey
    OR NEW.keyFingerprint IS NOT OLD.keyFingerprint OR NEW.createdAt IS NOT OLD.createdAt OR NEW.reason IS NOT OLD.reason
    OR NOT (OLD.current = 1 AND NEW.current = 0)
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;

CREATE TABLE coordinator_key (
  id TEXT PRIMARY KEY,
  publicKey TEXT NOT NULL UNIQUE,
  keyFingerprint TEXT NOT NULL,
  memberId TEXT NOT NULL REFERENCES member (id),
  state TEXT NOT NULL CHECK (state IN ('registered', 'withdrawn')),
  registeredAt TEXT NOT NULL,
  withdrawnAt TEXT
);
CREATE UNIQUE INDEX coordinator_key_one_registered ON coordinator_key (memberId) WHERE state = 'registered';
CREATE TRIGGER coordinator_key_no_delete BEFORE DELETE ON coordinator_key
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER coordinator_key_only_withdraw BEFORE UPDATE ON coordinator_key
  WHEN NEW.id IS NOT OLD.id OR NEW.publicKey IS NOT OLD.publicKey OR NEW.keyFingerprint IS NOT OLD.keyFingerprint
    OR NEW.memberId IS NOT OLD.memberId OR NEW.registeredAt IS NOT OLD.registeredAt
    OR NOT (OLD.state = 'registered' AND NEW.state = 'withdrawn' AND NEW.withdrawnAt IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;

CREATE TABLE registry_version (
  number INTEGER PRIMARY KEY CHECK (number >= 1),
  document TEXT NOT NULL,
  bodySha256 TEXT NOT NULL,
  signedBy TEXT NOT NULL,
  appliedAt TEXT NOT NULL,
  appliedBy TEXT NOT NULL REFERENCES member (id)
);
CREATE TRIGGER registry_version_no_update BEFORE UPDATE ON registry_version
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER registry_version_no_delete BEFORE DELETE ON registry_version
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;

CREATE TABLE registry_conflict (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL CHECK (number >= 1),
  document TEXT NOT NULL,
  bodySha256 TEXT NOT NULL,
  receivedAt TEXT NOT NULL,
  receivedBy TEXT NOT NULL REFERENCES member (id),
  resolvedBy INTEGER
);
CREATE TRIGGER registry_conflict_no_delete BEFORE DELETE ON registry_conflict
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER registry_conflict_only_resolve BEFORE UPDATE ON registry_conflict
  WHEN NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number OR NEW.document IS NOT OLD.document
    OR NEW.bodySha256 IS NOT OLD.bodySha256 OR NEW.receivedAt IS NOT OLD.receivedAt OR NEW.receivedBy IS NOT OLD.receivedBy
    OR NOT (OLD.resolvedBy IS NULL AND NEW.resolvedBy IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
`;
// Таблицы Реестра схемы 4: версию, отданную Ретранслятором при входе, передала служба — appliedBy и
// receivedBy допускают NULL (RELAY-18, NET-08; data-model.md фичи 004).
const REGISTRY_V4 = (suffix: string) => `
CREATE TABLE registry_version${suffix} (
  number INTEGER PRIMARY KEY CHECK (number >= 1),
  document TEXT NOT NULL,
  bodySha256 TEXT NOT NULL,
  signedBy TEXT NOT NULL,
  appliedAt TEXT NOT NULL,
  appliedBy TEXT REFERENCES member (id)
);
CREATE TABLE registry_conflict${suffix} (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL CHECK (number >= 1),
  document TEXT NOT NULL,
  bodySha256 TEXT NOT NULL,
  receivedAt TEXT NOT NULL,
  receivedBy TEXT REFERENCES member (id),
  resolvedBy INTEGER
);`;

const REGISTRY_TRIGGERS = `
CREATE TRIGGER registry_version_no_update BEFORE UPDATE ON registry_version
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER registry_version_no_delete BEFORE DELETE ON registry_version
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER registry_conflict_no_delete BEFORE DELETE ON registry_conflict
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER registry_conflict_only_resolve BEFORE UPDATE ON registry_conflict
  WHEN NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number OR NEW.document IS NOT OLD.document
    OR NEW.bodySha256 IS NOT OLD.bodySha256 OR NEW.receivedAt IS NOT OLD.receivedAt OR NEW.receivedBy IS NOT OLD.receivedBy
    OR NOT (OLD.resolvedBy IS NULL AND NEW.resolvedBy IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
`;

// Станции, Приглашения, сеансы и параметры Группы схемы 4 (data-model.md фичи 004; STATION-08,
// STATION-13, STATION-22, STATION-34, STATION-44). Секретов и адресов здесь нет: у Приглашения —
// открытый ключ Прохода и хэш ключа приёма, у сеанса — хэш токена.
const V4_STATIONS = `
CREATE TABLE invitation (
  id TEXT PRIMARY KEY,
  memberId TEXT NOT NULL REFERENCES member (id),
  issuedBy TEXT REFERENCES member (id),
  issuedAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  passageKey TEXT NOT NULL UNIQUE,
  acceptKeyHash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'used', 'cancelled')),
  usedAt TEXT,
  cancelledAt TEXT,
  cancelledBy TEXT REFERENCES member (id),
  CHECK (issuedBy IS NULL OR issuedBy <> memberId)
);
CREATE INDEX invitation_member ON invitation (memberId);
CREATE TRIGGER invitation_no_delete BEFORE DELETE ON invitation
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER invitation_only_from_issued BEFORE UPDATE ON invitation
  WHEN NEW.id IS NOT OLD.id OR NEW.memberId IS NOT OLD.memberId OR NEW.issuedBy IS NOT OLD.issuedBy
    OR NEW.issuedAt IS NOT OLD.issuedAt OR NEW.expiresAt IS NOT OLD.expiresAt OR NEW.passageKey IS NOT OLD.passageKey
    OR NEW.acceptKeyHash IS NOT OLD.acceptKeyHash OR OLD.state <> 'issued' OR NEW.state NOT IN ('used', 'cancelled')
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;

CREATE TABLE station (
  id TEXT PRIMARY KEY,
  memberId TEXT NOT NULL REFERENCES member (id),
  publicKey TEXT NOT NULL UNIQUE,
  keyFingerprint TEXT NOT NULL,
  invitationId TEXT NOT NULL UNIQUE REFERENCES invitation (id),
  acceptedAt TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  revokedAt TEXT,
  revokedBy TEXT REFERENCES member (id),
  revokeReason TEXT CHECK (revokeReason IS NULL OR revokeReason IN ('revoked', 'member-revoked', 'handover')),
  deleteOnlyUntil TEXT,
  deletionConfirmedAt TEXT
);
CREATE INDEX station_member ON station (memberId);
CREATE TRIGGER station_no_delete BEFORE DELETE ON station
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER station_only_revoke BEFORE UPDATE ON station
  WHEN NEW.id IS NOT OLD.id OR NEW.memberId IS NOT OLD.memberId OR NEW.publicKey IS NOT OLD.publicKey
    OR NEW.keyFingerprint IS NOT OLD.keyFingerprint OR NEW.invitationId IS NOT OLD.invitationId OR NEW.acceptedAt IS NOT OLD.acceptedAt
    OR (OLD.state = 'revoked' AND (NEW.state IS NOT OLD.state OR NEW.revokedAt IS NOT OLD.revokedAt OR NEW.revokedBy IS NOT OLD.revokedBy
      OR NEW.revokeReason IS NOT OLD.revokeReason OR NEW.deleteOnlyUntil IS NOT OLD.deleteOnlyUntil))
    OR (OLD.deletionConfirmedAt IS NOT NULL AND NEW.deletionConfirmedAt IS NOT OLD.deletionConfirmedAt)
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;

CREATE TABLE station_session (
  id TEXT PRIMARY KEY,
  stationId TEXT NOT NULL REFERENCES station (id),
  tokenHash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('full', 'delete-only')),
  startedAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  endedAt TEXT,
  endReason TEXT CHECK (endReason IS NULL OR endReason IN ('exit', 'expired', 'revoked'))
);
CREATE INDEX station_session_station ON station_session (stationId, startedAt);

CREATE TABLE group_setting (
  key TEXT PRIMARY KEY CHECK (key IN ('invitationHours', 'deleteOnlyDays')),
  value INTEGER NOT NULL,
  CHECK ((key = 'invitationHours' AND value BETWEEN 1 AND 168) OR (key = 'deleteOnlyDays' AND value BETWEEN 1 AND 365))
);
INSERT INTO group_setting (key, value) VALUES ('invitationHours', 72), ('deleteOnlyDays', 90);
`;

// Словарь Сети, Местное расширение, Номера Кейсов и производное схемы 5 (data-model.md фичи 005;
// research R1, R3, R9, R10, R17). Материализованный Словарь и производное пересобираются из версий
// Словаря и Записей; версии Словаря, Номера и предложения только дописываются.
const V5_MODEL = `
CREATE INDEX journal_case ON journal (caseId, seq);

CREATE TABLE dictionary_version (
  number INTEGER PRIMARY KEY CHECK (number >= 1),
  document TEXT NOT NULL,
  bodySha256 TEXT NOT NULL,
  signedBy TEXT NOT NULL,
  appliedAt TEXT NOT NULL,
  appliedBy TEXT REFERENCES member (id)
);
CREATE TRIGGER dictionary_version_no_update BEFORE UPDATE ON dictionary_version
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER dictionary_version_no_delete BEFORE DELETE ON dictionary_version
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;

CREATE TABLE dict_element (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('object_type', 'link_type', 'indicator_type', 'enum', 'enum_value')),
  level TEXT NOT NULL CHECK (level IN ('network', 'local')),
  state TEXT NOT NULL CHECK (state IN ('active', 'deprecated', 'absorbed')),
  canonicalId TEXT,
  sinceVersion INTEGER,
  props TEXT NOT NULL CHECK (json_valid(props)),
  CHECK ((state = 'absorbed') = (canonicalId IS NOT NULL))
);
CREATE INDEX dict_element_code ON dict_element (kind, code);

CREATE TABLE dict_template (
  classId TEXT NOT NULL,
  subtypeId TEXT,
  block TEXT NOT NULL CHECK (block IN ('header', 'media', 'os', 'class')),
  position INTEGER NOT NULL,
  field TEXT NOT NULL CHECK (json_valid(field)),
  local INTEGER NOT NULL DEFAULT 0 CHECK (local IN (0, 1))
);
CREATE INDEX dict_template_class ON dict_template (classId, subtypeId);

CREATE TABLE stop_list (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  builtAt TEXT NOT NULL,
  rows INTEGER NOT NULL CHECK (rows >= 0),
  level TEXT NOT NULL CHECK (level IN ('network', 'local'))
);
CREATE TABLE stop_list_entry (
  id TEXT PRIMARY KEY,
  listId TEXT NOT NULL REFERENCES stop_list (id),
  typeId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('value', 'range', 'pattern')),
  value TEXT NOT NULL,
  normalized TEXT NOT NULL,
  note TEXT NOT NULL CHECK (length(trim(note)) > 0)
);
CREATE INDEX stop_list_entry_list ON stop_list_entry (listId);
CREATE INDEX stop_list_entry_value ON stop_list_entry (typeId, normalized);

CREATE TABLE local_override (
  elementId TEXT NOT NULL,
  property TEXT NOT NULL CHECK (property IN ('identifying', 'autoSecret')),
  value TEXT NOT NULL,
  setBy TEXT REFERENCES member (id),
  setAt TEXT NOT NULL,
  PRIMARY KEY (elementId, property)
);

CREATE TABLE local_proposal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('type', 'enum_value', 'template_field', 'stop_list_entry', 'override')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'rejected')),
  proposedBy TEXT NOT NULL REFERENCES member (id),
  proposedAt TEXT NOT NULL,
  decidedBy TEXT REFERENCES member (id),
  decidedAt TEXT,
  reason TEXT,
  resultId TEXT,
  CHECK (state = 'proposed' OR (decidedBy IS NOT NULL AND decidedAt IS NOT NULL)),
  CHECK (state <> 'rejected' OR length(trim(coalesce(reason, ''))) > 0)
);
CREATE TRIGGER local_proposal_no_delete BEFORE DELETE ON local_proposal
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;
CREATE TRIGGER local_proposal_only_decide BEFORE UPDATE ON local_proposal
  WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.payload IS NOT OLD.payload OR NEW.proposedBy IS NOT OLD.proposedBy
    OR NEW.proposedAt IS NOT OLD.proposedAt OR OLD.state <> 'proposed' OR NEW.state NOT IN ('accepted', 'rejected')
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_NETWORK}'); END;

CREATE TABLE case_number_counter (
  year INTEGER PRIMARY KEY,
  last INTEGER NOT NULL CHECK (last >= 0)
);
CREATE TRIGGER case_number_counter_no_delete BEFORE DELETE ON case_number_counter
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY}'); END;
CREATE TRIGGER case_number_counter_forward BEFORE UPDATE ON case_number_counter
  WHEN NEW.year IS NOT OLD.year OR NEW.last < OLD.last
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY}'); END;
CREATE TABLE case_number (
  number TEXT PRIMARY KEY,
  caseId TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  UNIQUE (year, seq)
);
CREATE TRIGGER case_number_no_update BEFORE UPDATE ON case_number
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY}'); END;
CREATE TRIGGER case_number_no_delete BEFORE DELETE ON case_number
  BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY}'); END;

CREATE TABLE record_case (
  recordId TEXT PRIMARY KEY,
  caseId TEXT NOT NULL
);
CREATE INDEX record_case_case ON record_case (caseId);

CREATE TABLE indicator_value (
  recordId TEXT PRIMARY KEY,
  canonicalTypeId TEXT NOT NULL,
  normClass TEXT,
  normalized TEXT,
  flags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags)),
  stopListEntryId TEXT,
  identifying INTEGER NOT NULL CHECK (identifying IN (0, 1))
);
CREATE INDEX indicator_value_norm ON indicator_value (canonicalTypeId, normalized);
CREATE INDEX indicator_value_stop ON indicator_value (stopListEntryId);
`;

// Новый Банк схемы 2 — только для тестов миграции 2 → 3; рабочий новый Банк — сразу схема 5.
const SCHEMA_V2_NEW = bankTables(memberV2("member")) + V2_ADDITIONS;
const SCHEMA_V3_NEW = bankTables(memberV2("member"), journalV3("journal")) + V2_ADDITIONS + V3_NETWORK;
// Схема 4 нового Банка: таблицы Сети схемы 3, Реестр — с автором-службой, Станции (research R18).
const V3_NETWORK_WITHOUT_REGISTRY = V3_NETWORK.slice(0, V3_NETWORK.indexOf("CREATE TABLE registry_version"));
const SCHEMA_V4_NEW =
  bankTables(memberV2("member"), journalV4("journal")) + V2_ADDITIONS + V3_NETWORK_WITHOUT_REGISTRY + REGISTRY_V4("") + REGISTRY_TRIGGERS + V4_STATIONS;
// Схема 5 нового Банка: схема 4 с журналом схемы 5 и таблицами модели (research R17 фичи 005).
const SCHEMA_V5_NEW =
  bankTables(memberV2("member"), journalV5("journal")) + V2_ADDITIONS + V3_NETWORK_WITHOUT_REGISTRY + REGISTRY_V4("") + REGISTRY_TRIGGERS + V4_STATIONS + V5_MODEL;

// Таблицы Материалов (research R11 фичи 006; data-model.md «Таблицы схемы 6»): состояние доставки и
// удаления, Заверения по порядку получения, недоставленная часть. Запись о Материале — в record.
const V6_MATERIALS = `
CREATE TABLE material_state (
  id TEXT PRIMARY KEY REFERENCES record (id),
  ownerType TEXT NOT NULL CHECK (ownerType IN ('case', 'document')),
  ownerId TEXT NOT NULL,
  pathKey TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('pending', 'delivered')),
  deliveredAt TEXT,
  deliveredByStation TEXT,
  currentAttestation INTEGER NOT NULL CHECK (currentAttestation >= 1),
  deletedAt TEXT,
  deletedBy TEXT REFERENCES member (id),
  deleteReason TEXT,
  treeCleanup INTEGER NOT NULL DEFAULT 0 CHECK (treeCleanup IN (0, 1)),
  UNIQUE (ownerType, ownerId, pathKey)
);
CREATE INDEX material_state_owner ON material_state (ownerType, ownerId);

CREATE TABLE material_attestation (
  materialId TEXT NOT NULL REFERENCES material_state (id),
  n INTEGER NOT NULL CHECK (n >= 1),
  json TEXT NOT NULL CHECK (json_valid(json)),
  stationId TEXT NOT NULL,
  stationKey TEXT NOT NULL,
  receivedAt TEXT NOT NULL,
  PRIMARY KEY (materialId, n)
);
CREATE INDEX material_attestation_station ON material_attestation (stationId);

CREATE TABLE material_upload (
  materialId TEXT PRIMARY KEY REFERENCES material_state (id),
  stationId TEXT NOT NULL,
  received INTEGER NOT NULL CHECK (received >= 0),
  startedAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  takenOverFrom TEXT
);
`;

// Миграция 4 → 5 (research R17 фичи 005): журнал перестраивается ради caseId и новых предметов;
// строки и seq сохраняются, caseId прежних строк — NULL.
const SCHEMA_V4_TO_V5 = `
${journalV5("journal_new")}
INSERT INTO journal_new (seq, at, actorId, action, subjectType, subjectId, historyFrom, historyTo, details, caseId)
  SELECT seq, at, actorId, action, subjectType, subjectId, historyFrom, historyTo, details, NULL FROM journal ORDER BY seq;
DROP TABLE journal;
ALTER TABLE journal_new RENAME TO journal;
${JOURNAL_INDEXES}
${JOURNAL_TRIGGERS}
${V5_MODEL}`;

// Миграция 3 → 4 (research R18): журнал — ради новых предметов, таблицы Реестра — ради автора-службы;
// строки и seq сохраняются.
const SCHEMA_V3_TO_V4 = `
${journalV4("journal_new")}
INSERT INTO journal_new (seq, at, actorId, action, subjectType, subjectId, historyFrom, historyTo, details)
  SELECT seq, at, actorId, action, subjectType, subjectId, historyFrom, historyTo, details FROM journal ORDER BY seq;
DROP TABLE journal;
ALTER TABLE journal_new RENAME TO journal;
${JOURNAL_INDEXES}
${JOURNAL_TRIGGERS}
${REGISTRY_V4("_new")}
INSERT INTO registry_version_new SELECT number, document, bodySha256, signedBy, appliedAt, appliedBy FROM registry_version ORDER BY number;
INSERT INTO registry_conflict_new SELECT id, number, document, bodySha256, receivedAt, receivedBy, resolvedBy FROM registry_conflict ORDER BY rowid;
DROP TABLE registry_version;
DROP TABLE registry_conflict;
ALTER TABLE registry_version_new RENAME TO registry_version;
ALTER TABLE registry_conflict_new RENAME TO registry_conflict;
${REGISTRY_TRIGGERS}
${V4_STATIONS}`;

// Миграция 2 → 3 (research R11): журнал перестраивается — NOT NULL и CHECK на месте не изменить;
// seq сохраняются, sqlite_sequence переименовывается вместе с таблицей.
const SCHEMA_V2_TO_V3 = `
${journalV3("journal_new")}
INSERT INTO journal_new (seq, at, actorId, action, subjectType, subjectId, historyFrom, historyTo, details)
  SELECT seq, at, actorId, action, subjectType, subjectId, historyFrom, historyTo, details FROM journal ORDER BY seq;
DROP TABLE journal;
ALTER TABLE journal_new RENAME TO journal;
${JOURNAL_INDEXES}
${JOURNAL_TRIGGERS}
${V3_NETWORK}`;

// Миграция 1 → 2 (research R5): member перестраивается — CHECK ролей и состояний на месте не расширить.
const SCHEMA_V1_TO_V2 = `
${memberV2("member_new")}
INSERT INTO member_new (id, label, role, state, version, createdAt, bootstrap)
  SELECT id, label, role, state, 1, createdAt, bootstrap FROM member ORDER BY rowid;
DROP TABLE member;
ALTER TABLE member_new RENAME TO member;
CREATE UNIQUE INDEX member_one_bootstrap ON member (bootstrap) WHERE bootstrap = 1;
${V2_ADDITIONS}`;

/** Точки внедрения сбоя — только для тестов миграции (T001). */
export interface MigrationFaults {
  duringV2?: () => void;
  duringV3?: () => void;
  duringV4?: () => void;
  duringV5?: () => void;
  duringV6?: () => void;
}

export interface MigrateOptions {
  /** До какой версии схемы дойти; меньше текущей — только в тестах (Банк прежней схемы). */
  target?: number;
  faults?: MigrationFaults;
}

export interface BankIdentity {
  role: string;
  installId: string;
  createdAt: string;
}

function currentVersion(db: Db): number {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'meta'").get();
  if (exists === undefined) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
  return row === undefined ? 0 : Number(row["value"]);
}

/** Создать или обновить схему Банка; identity пишется в meta при создании. */
export function migrate(db: Db, identity?: BankIdentity, options: MigrateOptions = {}): void {
  const target = options.target ?? SCHEMA_VERSION;
  const version = currentVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(message("schema_newer", { version, supported: SCHEMA_VERSION }));
  }
  if (version < 1) createBank(db, Math.min(target, SCHEMA_VERSION), identity);
  if (currentVersion(db) < 2 && target >= 2) migrateV1ToV2(db, options.faults);
  if (currentVersion(db) < 3 && target >= 3) migrateV2ToV3(db, options.faults);
  if (currentVersion(db) < 4 && target >= 4) migrateV3ToV4(db, options.faults);
  if (currentVersion(db) < 5 && target >= 5) migrateV4ToV5(db, options.faults);
  if (currentVersion(db) < 6 && target >= 6) migrateV5ToV6(db, options.faults);
}

/** Схема 5 → 6 (research R11 фичи 006): только новые таблицы — данных Материалов до фичи 006 нет. */
function migrateV5ToV6(db: Db, faults: MigrationFaults = {}): void {
  inTransaction(db, () => {
    if (currentVersion(db) >= 6) return;
    db.exec(V6_MATERIALS);
    faults.duringV6?.();
    db.prepare("UPDATE meta SET value = '6' WHERE key = 'schemaVersion'").run();
  });
}

/** Схема 4 → 5 той же процедурой, что 3 → 4 (research R17 фичи 005). */
function migrateV4ToV5(db: Db, faults: MigrationFaults = {}): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    inTransaction(db, () => {
      if (currentVersion(db) >= 5) return;
      db.exec(SCHEMA_V4_TO_V5);
      faults.duringV5?.();
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(message("schema_foreign_keys_broken", { count: broken.length }));
      db.prepare("UPDATE meta SET value = '5' WHERE key = 'schemaVersion'").run();
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Схема 3 → 4 той же процедурой, что 2 → 3 (research R18 фичи 004). */
function migrateV3ToV4(db: Db, faults: MigrationFaults = {}): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    inTransaction(db, () => {
      if (currentVersion(db) >= 4) return;
      db.exec(SCHEMA_V3_TO_V4);
      faults.duringV4?.();
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(message("schema_foreign_keys_broken", { count: broken.length }));
      db.prepare("UPDATE meta SET value = '4' WHERE key = 'schemaVersion'").run();
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Схема 2 → 3 той же процедурой, что 1 → 2: внешние ключи выключаются до транзакции (research R11). */
function migrateV2ToV3(db: Db, faults: MigrationFaults = {}): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    inTransaction(db, () => {
      if (currentVersion(db) >= 3) return;
      db.exec(SCHEMA_V2_TO_V3);
      faults.duringV3?.();
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(message("schema_foreign_keys_broken", { count: broken.length }));
      db.prepare("UPDATE meta SET value = '3' WHERE key = 'schemaVersion'").run();
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Схема 1 → 2. Внешние ключи выключаются до транзакции: внутри неё PRAGMA foreign_keys ничего
 * не делает, а DROP TABLE member со включёнными ключами выполнил бы неявный DELETE, нарушающий
 * ссылки record, record_history и journal (research R5).
 */
function migrateV1ToV2(db: Db, faults: MigrationFaults = {}): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    inTransaction(db, () => {
      if (currentVersion(db) >= 2) return;
      db.exec(SCHEMA_V1_TO_V2);
      faults.duringV2?.();
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error(message("schema_foreign_keys_broken", { count: broken.length }));
      db.prepare("UPDATE meta SET value = '2' WHERE key = 'schemaVersion'").run();
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Новый Банк сразу нужной схемы: 6, а схемы 1 … 5 — только для тестов миграции. */
function createBank(db: Db, version: number, identity?: BankIdentity): void {
  inTransaction(db, () => {
    // Схему мог создать параллельный процесс, пока мы ждали блокировку записи.
    if (currentVersion(db) >= 1) return;
    db.exec(version >= 6 ? SCHEMA_V5_NEW + V6_MATERIALS : version === 5 ? SCHEMA_V5_NEW : version === 4 ? SCHEMA_V4_NEW : version === 3 ? SCHEMA_V3_NEW : version === 2 ? SCHEMA_V2_NEW : SCHEMA_V1);
    const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    put.run("schemaVersion", String(version));
    // Какой схемой Банк создан: Ключ Группы нового Банка — reason install, прежнего — upgrade (research R2).
    put.run("createdWithSchema", String(version));
    if (identity !== undefined) {
      put.run("role", identity.role);
      put.run("installId", identity.installId);
      put.run("createdAt", identity.createdAt);
    }
  });
}
