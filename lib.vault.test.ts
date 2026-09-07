import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Database } from "./db"
import { initPluginGuard, createSchema, ensureProject } from "./lib"
import { vaultInit, vaultOpen, vaultClose, getVaultTmp } from "./lib.vault"

initPluginGuard()

function createTestDb(): Database {
  const db = new Database(":memory:")
  createSchema(db)
  db.exec(`CREATE TABLE IF NOT EXISTS permission (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`)
  return db
}
function stubSession(db: Database, id: string, projectId: string, dir: string) {
  ensureProject(db, projectId, dir)
  const now = Date.now()
  db.run(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, 'test', ?, 'Test', 'v2', ?, ?)`, [id, projectId, dir, now, now])
}

describe("vault", () => {
  let dir: string
  let db: Database
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-"))
    mkdirSync(join(dir, "secrets"))
    writeFileSync(join(dir, "secrets", "api.env"), "KEY=123")
    db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(getVaultTmp("ses_1"), { recursive: true, force: true })
  })

  it("init encrypts directory", () => {
    const res = vaultInit(join(dir, "secrets"), "pass123")
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, "secrets"))).toBe(false)
    expect(existsSync(join(dir, "secrets.age"))).toBe(true)
  })

  it("open decrypts session-scoped and grants permission", () => {
    vaultInit(join(dir, "secrets"), "pass123")
    const res = vaultOpen(db, "ses_1", join(dir, "secrets"), "pass123")
    expect(res.ok).toBe(true)
    expect(existsSync(join(getVaultTmp("ses_1"), "api.env"))).toBe(true)
    const row = db.query("SELECT resource FROM permission WHERE project_id='proj_1'").get() as { resource: string } | null
    expect(row!.resource).toContain("vault-ses_1")
  })

  it("close wipes and removes permission", () => {
    vaultInit(join(dir, "secrets"), "pass123")
    vaultOpen(db, "ses_1", join(dir, "secrets"), "pass123")
    const res = vaultClose(db, "ses_1", join(dir, "secrets"), "pass123")
    expect(res.ok).toBe(true)
    expect(existsSync(getVaultTmp("ses_1"))).toBe(false)
    const cnt = db.query("SELECT count(*) as c FROM permission").get() as { c: number } | null
    expect(cnt!.c).toBe(0)
  })

  it("open fails with wrong passphrase", () => {
    vaultInit(join(dir, "secrets"), "pass123")
    const res = vaultOpen(db, "ses_1", join(dir, "secrets"), "wrong")
    expect(res.ok).toBe(false)
  })

  it("init is directories only", () => {
    const file = join(dir, "single.txt")
    writeFileSync(file, "hi")
    const res = vaultInit(file, "pass")
    expect(res.ok).toBe(false)
    expect(res.error).toContain("directory")
  })
})
