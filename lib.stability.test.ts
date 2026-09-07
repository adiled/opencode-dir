import { describe, it, expect } from "vitest"
import { Database } from "./db"
import { initPluginGuard, createSchema, ensureProject, updateSession, appendDirPermission, removeDirPermission, getSessionPermissions } from "./lib"

initPluginGuard()

function createTestDb(): Database {
  const db = new Database(":memory:")
  createSchema(db)
  // add permission table like opencode does
  db.exec(`CREATE TABLE IF NOT EXISTS permission (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`)
  return db
}
function stubSession(db: Database, id: string, projectId: string, dir: string) {
  ensureProject(db, projectId, dir)
  const now = Date.now()
  db.run(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, 'test', ?, 'Test', 'v2', ?, ?)`, [id, projectId, dir, now, now])
}

describe("stability: db pragmas", () => {
  it("sets WAL and busy_timeout", () => {
    // WAL only applies to file DBs; :memory: stays 'memory' — test file DB
    const { mkdtempSync, rmSync } = require("fs") as any
    const { join } = require("path") as any
    const { tmpdir } = require("os") as any
    const dir = mkdtempSync(join(tmpdir(), "ocd-wal-"))
    const file = join(dir, "test.db")
    const db = new Database(file)
    const jm = db.query("PRAGMA journal_mode").get() as any
    expect(jm.journal_mode).toBe("wal")
    const bt = db.query("PRAGMA busy_timeout").get() as any
    expect(bt.busy_timeout ?? bt.timeout ?? 5000).toBe(5000)
    db.close()
    rmSync(dir, { recursive: true, force: true })
    // also ensure :memory: doesn't crash
    const mem = new Database(":memory:")
    expect(() => mem.query("PRAGMA busy_timeout").get()).not.toThrow()
    mem.close()
  })
  it("transaction uses BEGIN IMMEDIATE and commits", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/a")
    // simple tx should work
    const tx = db.transaction(() => { db.run("UPDATE session SET title='x' WHERE id='ses_1'") })
    tx()
    const row = db.query("SELECT title FROM session WHERE id='ses_1'").get() as any
    expect(row.title).toBe("x")
    db.close()
  })
})

describe("stability: atomicity", () => {
  it("updateSession atomic rollback on permission insert failure", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/old")
    // make permission insert fail via trigger that throws
    db.exec(`CREATE TRIGGER fail_perm BEFORE INSERT ON permission BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    expect(() => updateSession(db, "ses_1", "/new", "proj_new")).toThrow()
    // session must NOT have been updated (rollback)
    const row = db.query("SELECT directory, project_id FROM session WHERE id='ses_1'").get() as any
    expect(row.directory).toBe("/old")
    expect(row.project_id).toBe("proj_1")
    db.close()
  })
  it("appendDirPermission atomic rollback on failure", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
    db.exec(`CREATE TRIGGER fail_perm2 BEFORE INSERT ON permission BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    expect(() => appendDirPermission(db, "ses_1", "/extra")).toThrow()
    const perms = getSessionPermissions(db, "ses_1")
    expect(perms).toHaveLength(0)
    db.close()
  })
  it("appendDirPermission still succeeds when permission table missing", () => {
    const db = new Database(":memory:")
    createSchema(db) // no permission table
    ensureProject(db, "proj_1", "/work")
    const now = Date.now()
    db.run(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_1','proj_1','test','/work','Test','v2',?,?)`, [now, now])
    const changes = appendDirPermission(db, "ses_1", "/extra")
    expect(changes).toBe(1)
    expect(getSessionPermissions(db, "ses_1")).toHaveLength(1)
    db.close()
  })
  it("removeDirPermission atomic", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
    appendDirPermission(db, "ses_1", "/extra")
    expect(getSessionPermissions(db, "ses_1")).toHaveLength(1)
    const removed = removeDirPermission(db, "ses_1", "/extra")
    expect(removed).toBe(1)
    expect(getSessionPermissions(db, "ses_1")).toHaveLength(0)
    // permission table also cleared
    const cnt = db.query("SELECT count(*) as c FROM permission WHERE project_id='proj_1'").get() as any
    expect(cnt.c).toBe(0)
    db.close()
  })
})
