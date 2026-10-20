// T010 — прослойка БД: Database или DatabaseSync, прагмы, defensive, FTS5 (APP-30; research R2, R6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, pickDatabaseClass } from "../../src/db/open.ts";

class A {}
class B {}

test("pickDatabaseClass берёт Database, а без него — DatabaseSync (APP-30)", () => {
  assert.equal(pickDatabaseClass({ Database: A, DatabaseSync: B }), A);
  assert.equal(pickDatabaseClass({ DatabaseSync: B }), B);
  assert.throws(() => pickDatabaseClass({}));
});

test("openDatabase включает WAL, synchronous = FULL, foreign_keys и defensive; FTS5 доступен", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aristotel-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "bank.sqlite"));
  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
    assert.equal(db.prepare("PRAGMA synchronous").get()?.["synchronous"], 2);
    assert.equal(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
    // При флаге defensive writable_schema включить нельзя.
    db.exec("PRAGMA writable_schema = ON");
    assert.equal(db.prepare("PRAGMA writable_schema").get()?.["writable_schema"], 0);
    db.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(text)");
    db.prepare("INSERT INTO fts_probe(text) VALUES (?)").run("x y");
    assert.equal(db.prepare("SELECT count(*) AS n FROM fts_probe WHERE fts_probe MATCH 'x'").get()?.["n"], 1);
  } finally {
    db.close();
  }
});
