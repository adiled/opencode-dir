import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"
import { tmpdir } from "os"
import {
  createSchema,
  ensureProject,
  updateSession,
  rewriteMessages,
  getSessionInfo,
  getCurrentDirectory,
  getInitialCommit,
  resolveTarget,
  execMove,
  execAddDir,
  getSessionPermissions,
  appendDirPermission,
  loadOverrides,
  persistOverrides,
  getDbPath,
  hasSchema,
  meetsMinVersion,
} from "./lib"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:")
  createSchema(db)
  return db
}

function createGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocd-test-"))
  execSync(
    "git init && git config commit.gpgsign false && git commit --allow-empty -m init",
    {
      cwd: dir,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test",
      },
    },
  )
  return dir
}

function stubSession(db: Database, id: string, projectId: string, directory: string) {
  ensureProject(db, projectId, directory)
  const now = Date.now()
  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, 'test', ?, 'Test', 'v2', ?, ?)`,
    [id, projectId, directory, now, now],
  )
}

function stubMessage(db: Database, id: string, sessionId: string, data: Record<string, unknown>) {
  const now = Date.now()
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    [id, sessionId, now, now, JSON.stringify(data)],
  )
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// loadOverrides / persistOverrides
// ---------------------------------------------------------------------------

describe("overrides persistence", () => {
  let tmpDir: string
  let tmpFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ocd-test-"))
    tmpFile = join(tmpDir, "overrides.json")
  })
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it("returns empty map when file does not exist", () => {
    const map = loadOverrides(tmpFile + ".nope")
    expect(map.size).toBe(0)
  })

  it("round-trips overrides through disk", () => {
    const map = new Map([["ses_1", { oldDir: "/a", newDir: "/b" }]])
    persistOverrides(tmpFile, map)
    const loaded = loadOverrides(tmpFile)
    expect(loaded.size).toBe(1)
    expect(loaded.get("ses_1")).toEqual({ oldDir: "/a", newDir: "/b" })
  })

  it("writes file with 0600 permissions", () => {
    persistOverrides(tmpFile, new Map())
    const raw = readFileSync(tmpFile, "utf-8")
    expect(JSON.parse(raw)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getInitialCommit
// ---------------------------------------------------------------------------

describe("getInitialCommit", () => {
  let repo: string
  let nonGit: string

  beforeEach(() => {
    repo = createGitRepo()
    nonGit = mkdtempSync(join(tmpdir(), "ocd-test-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(nonGit, { recursive: true, force: true })
  })

  it("returns the root commit hash", () => {
    const hash = getInitialCommit(repo)
    expect(hash).toBeString()
    expect(hash!.length).toBe(40)
  })

  it("returns null for non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocd-test-"))
    expect(getInitialCommit(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

describe("resolveTarget", () => {
  let repo: string
  let nonGit: string

  beforeEach(() => {
    repo = createGitRepo()
    nonGit = mkdtempSync(join(tmpdir(), "ocd-test-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(nonGit, { recursive: true, force: true })
  })

  it("resolves a git repo to dir and projectId", () => {
    const result = resolveTarget(repo)
    expect(result.dir).toBe(repo)
    expect(result.projectId).toBeString()
    expect(result.projectId.length).toBe(40)
  })

  it("throws for nonexistent directory", () => {
    expect(() => resolveTarget("/no/such/path/xyz")).toThrow("does not exist")
  })

  it("resolves non-git directory with global projectId", () => {
    const result = resolveTarget(nonGit)
    expect(result.dir).toBe(nonGit)
    expect(result.projectId).toBe("global")
  })
})

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

describe("ensureProject", () => {
  it("creates a project row", () => {
    const db = createTestDb()
    ensureProject(db, "proj_1", "/work")
    const row = db.query("SELECT id, worktree FROM project WHERE id = ?").get("proj_1") as any
    expect(row.id).toBe("proj_1")
    expect(row.worktree).toBe("/work")
    db.close()
  })

  it("is idempotent", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
    ensureProject(db, "proj_1", "/work")
    ensureProject(db, "proj_1", "/work")
    const count = db.query("SELECT count(*) as c FROM project WHERE id = ?").get("proj_1") as any
    expect(count.c).toBe(1)
    db.close()
  })
})

describe("updateSession", () => {
  it("updates directory, project_id, and permission", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/old")
    ensureProject(db, "proj_new", "/new")
    const changes = updateSession(db, "ses_1", "/new", "proj_new")
    expect(changes).toBe(1)

    const row = db.query("SELECT directory, project_id, permission FROM session WHERE id = ?").get("ses_1") as any
    expect(row.directory).toBe("/new")
    expect(row.project_id).toBe("proj_new")

    const permission = JSON.parse(row.permission)
    expect(permission).toBeArrayOfSize(1)
    expect(permission[0].permission).toBe("external_directory")
    expect(permission[0].pattern).toBe("/new/*")
    expect(permission[0].action).toBe("allow")
    db.close()
  })

  it("returns 0 for nonexistent session", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/old")
    ensureProject(db, "proj_new", "/new")
    expect(updateSession(db, "ses_nope", "/new", "proj_new")).toBe(0)
    db.close()
  })
})

describe("getSessionInfo", () => {
  it("returns session directory and projectId", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
    const info = getSessionInfo(db, "ses_1")
    expect(info).toEqual({ directory: "/work", projectId: "proj_1" })
    db.close()
  })

  it("returns null for nonexistent session", () => {
    const db = createTestDb()
    expect(getSessionInfo(db, "nope")).toBeNull()
    db.close()
  })
})

describe("getCurrentDirectory", () => {
  it("extracts path.cwd from earliest message", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
    stubMessage(db, "msg_1", "ses_1", { path: { cwd: "/actual" } })
    stubMessage(db, "msg_2", "ses_1", { path: { cwd: "/later" } })
    expect(getCurrentDirectory(db, "ses_1")).toBe("/actual")
    db.close()
  })

  it("returns null when no messages have path info", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
    stubMessage(db, "msg_1", "ses_1", { role: "user", content: "hello" })
    expect(getCurrentDirectory(db, "ses_1")).toBeNull()
    db.close()
  })
})

describe("rewriteMessages", () => {
  it("rewrites path.cwd and path.root in messages", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/old")
    stubMessage(db, "msg_1", "ses_1", { path: { cwd: "/old", root: "/old" } })
    stubMessage(db, "msg_2", "ses_1", { path: { cwd: "/old" } })

    const result = rewriteMessages(db, "ses_1", "/old", "/new")
    expect(result.total).toBe(2)
    expect(result.rewritten).toBe(2)

    const rows = db.query("SELECT data FROM message WHERE session_id = ?").all("ses_1") as { data: string }[]
    const d1 = JSON.parse(rows[0].data)
    expect(d1.path.cwd).toBe("/new")
    expect(d1.path.root).toBe("/new")
    db.close()
  })

  it("leaves messages without path unchanged", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/old")
    stubMessage(db, "msg_1", "ses_1", { role: "user", content: "hello" })

    const result = rewriteMessages(db, "ses_1", "/old", "/new")
    expect(result.total).toBe(1)
    expect(result.rewritten).toBe(0)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// execMove (integration)
// ---------------------------------------------------------------------------

describe("execMove", () => {
  let repo: string
  let db: Database

  beforeEach(() => {
    repo = createGitRepo()
    db = createTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it("cd: updates session without rewriting messages", () => {
    const projectId = getInitialCommit(repo)!
    stubSession(db, "ses_1", "proj_old", "/old")
    stubMessage(db, "msg_1", "ses_1", { path: { cwd: "/old", root: "/old" } })

    const result = execMove("ses_1", repo, false, db)
    expect(result.result).toContain("Session directory changed")
    expect(result.result).toContain(repo)
    expect(result.oldDir).toBe("/old")
    expect(result.newDir).toBe(repo)

    // messages NOT rewritten
    const session = getSessionInfo(db, "ses_1")!
    expect(session.directory).toBe(repo)
    expect(session.projectId).toBe(projectId)
    const msg = db.query("SELECT data FROM message WHERE id = ?").get("msg_1") as any
    expect(JSON.parse(msg.data).path.cwd).toBe("/old") // unchanged
  })

  it("mv: updates session AND rewrites messages", () => {
    stubSession(db, "ses_1", "proj_old", "/old")
    stubMessage(db, "msg_1", "ses_1", { path: { cwd: "/old", root: "/old" } })

    const result = execMove("ses_1", repo, true, db)
    expect(result.result).toContain("Session moved")
    expect(result.result).toContain("rewritten")
    const msg = db.query("SELECT data FROM message WHERE id = ?").get("msg_1") as any
    expect(JSON.parse(msg.data).path.cwd).toBe(repo)
  })

  it("moves global project sessions into a git repo", () => {
    const projectId = getInitialCommit(repo)!
    stubSession(db, "ses_1", "global", "/tmp/plain")

    const result = execMove("ses_1", repo, false, db)
    expect(result.result).toContain("Session directory changed")

    const session = getSessionInfo(db, "ses_1")!
    expect(session.projectId).toBe(projectId)
  })

  it("returns error for nonexistent session", () => {
    const result = execMove("ses_nope", repo, false, db)
    expect(result.result).toContain("not found")
  })

  it("returns no-op when already in target directory", () => {
    const projectId = getInitialCommit(repo)!
    stubSession(db, "ses_1", projectId, repo)

    const result = execMove("ses_1", repo, false, db)
    expect(result.result).toContain("Already in")
    expect(result.result).toContain("no change")
  })

  it("writes session permission for target directory", () => {
    stubSession(db, "ses_1", "proj_old", "/old")

    execMove("ses_1", repo, false, db)

    const row = db.query("SELECT permission FROM session WHERE id = ?").get("ses_1") as any
    const perm = JSON.parse(row.permission)
    expect(perm[0].permission).toBe("external_directory")
    expect(perm[0].pattern).toBe(repo + "/*")
  })

  it("creates target project if it does not exist", () => {
    const projectId = getInitialCommit(repo)!
    stubSession(db, "ses_1", "proj_old", "/old")

    execMove("ses_1", repo, false, db)

    const row = db.query("SELECT id, worktree FROM project WHERE id = ?").get(projectId) as any
    expect(row).toBeTruthy()
    expect(row.worktree).toBe(repo)
  })

  it("returns error when database has no schema", () => {
    const emptyDb = new Database(":memory:")
    const result = execMove("ses_1", repo, false, emptyDb)
    expect(result.result).toContain("does not contain expected tables")
    emptyDb.close()
  })
})

// ---------------------------------------------------------------------------
// getDbPath
// ---------------------------------------------------------------------------

describe("getDbPath", () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    // Restore environment
    delete process.env.OPENCODE_DB
    delete process.env.OPENCODE_CHANNEL
    delete process.env.OPENCODE_DISABLE_CHANNEL_DB
    process.env.XDG_DATA_HOME = origEnv.XDG_DATA_HOME
    process.env.HOME = origEnv.HOME
  })

  it("returns opencode.db for latest channel", () => {
    delete process.env.OPENCODE_DB
    delete process.env.OPENCODE_CHANNEL
    const p = getDbPath()
    expect(p).toEndWith("/opencode/opencode.db")
  })

  it("returns channel-suffixed path for non-standard channel", () => {
    delete process.env.OPENCODE_DB
    process.env.OPENCODE_CHANNEL = "local"
    const p = getDbPath()
    expect(p).toEndWith("/opencode/opencode-local.db")
  })

  it("returns opencode.db when OPENCODE_DISABLE_CHANNEL_DB is set", () => {
    delete process.env.OPENCODE_DB
    process.env.OPENCODE_CHANNEL = "custom"
    process.env.OPENCODE_DISABLE_CHANNEL_DB = "1"
    const p = getDbPath()
    expect(p).toEndWith("/opencode/opencode.db")
  })

  it("respects OPENCODE_DB absolute override", () => {
    process.env.OPENCODE_DB = "/custom/path.db"
    expect(getDbPath()).toBe("/custom/path.db")
  })

  it("respects OPENCODE_DB relative override", () => {
    delete process.env.XDG_DATA_HOME
    process.env.OPENCODE_DB = "test.db"
    const p = getDbPath()
    expect(p).toEndWith("/opencode/test.db")
  })

  it("returns :memory: for OPENCODE_DB=:memory:", () => {
    process.env.OPENCODE_DB = ":memory:"
    expect(getDbPath()).toBe(":memory:")
  })
})

// ---------------------------------------------------------------------------
// appendDirPermission
// ---------------------------------------------------------------------------

describe("appendDirPermission", () => {
  it("appends permission rule to session with no existing permissions", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")

    const changes = appendDirPermission(db, "ses_1", "/extra")
    expect(changes).toBe(1)

    const perms = getSessionPermissions(db, "ses_1")
    expect(perms).toEqual([
      { permission: "external_directory", pattern: "/extra/*", action: "allow" },
    ])
    db.close()
  })

  it("preserves existing permissions from cd/mv", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
    updateSession(db, "ses_1", "/new", "proj_new")

    const changes = appendDirPermission(db, "ses_1", "/extra")
    expect(changes).toBe(1)

    const perms = getSessionPermissions(db, "ses_1")
    expect(perms).toEqual([
      { permission: "external_directory", pattern: "/new/*", action: "allow" },
      { permission: "external_directory", pattern: "/extra/*", action: "allow" },
    ])
    db.close()
  })

  it("returns -1 for duplicate directory", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")

    appendDirPermission(db, "ses_1", "/extra")
    const result = appendDirPermission(db, "ses_1", "/extra")
    expect(result).toBe(-1)

    const perms = getSessionPermissions(db, "ses_1")
    expect(perms).toHaveLength(1)
    db.close()
  })

  it("returns 0 for nonexistent session", () => {
    const db = createTestDb()
    const changes = appendDirPermission(db, "ses_nope", "/extra")
    expect(changes).toBe(0)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// hasSchema
// ---------------------------------------------------------------------------

describe("hasSchema", () => {
  it("returns true for a database with the session table", () => {
    const db = createTestDb()
    expect(hasSchema(db)).toBe(true)
    db.close()
  })

  it("returns false for an empty database", () => {
    const db = new Database(":memory:")
    expect(hasSchema(db)).toBe(false)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// execAddDir (integration)
// ---------------------------------------------------------------------------

describe("execAddDir", () => {
  let repo: string
  let db: Database

  beforeEach(() => {
    repo = createGitRepo()
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it("grants access to an additional directory", () => {
    stubSession(db, "ses_1", "proj_1", "/work")

    const result = execAddDir("ses_1", repo, db)
    expect(result.result).toContain("Added directory")
    expect(result.result).toContain(repo)

    const perms = getSessionPermissions(db, "ses_1")
    expect(perms).toEqual([
      { permission: "external_directory", pattern: repo + "/*", action: "allow" },
    ])
  })

  it("does not change session directory or project", () => {
    stubSession(db, "ses_1", "proj_1", "/work")

    execAddDir("ses_1", repo, db)

    const session = getSessionInfo(db, "ses_1")!
    expect(session.directory).toBe("/work")
    expect(session.projectId).toBe("proj_1")
  })

  it("returns no-op for duplicate directory", () => {
    stubSession(db, "ses_1", "proj_1", "/work")

    execAddDir("ses_1", repo, db)
    const result = execAddDir("ses_1", repo, db)
    expect(result.result).toContain("already accessible")
  })

  it("returns error for nonexistent session", () => {
    const result = execAddDir("ses_nope", repo, db)
    expect(result.result).toContain("not found")
  })

  it("returns error for nonexistent directory", () => {
    stubSession(db, "ses_1", "proj_1", "/work")

    const result = execAddDir("ses_1", "/no/such/path/xyz", db)
    expect(result.result).toContain("Error")
  })

  it("allows adding multiple directories", () => {
    const repo2 = createGitRepo()
    stubSession(db, "ses_1", "proj_1", "/work")

    execAddDir("ses_1", repo, db)
    execAddDir("ses_1", repo2, db)

    const perms = getSessionPermissions(db, "ses_1")
    expect(perms).toHaveLength(2)
    expect(perms).toEqual([
      { permission: "external_directory", pattern: repo + "/*", action: "allow" },
      { permission: "external_directory", pattern: repo2 + "/*", action: "allow" },
    ])
    rmSync(repo2, { recursive: true, force: true })
  })
})

describe("meetsMinVersion", () => {
  it("returns true when version equals minimum", () => {
    expect(meetsMinVersion("1.4.3", "1.4.3")).toBe(true)
  })
  it("returns true when version exceeds minimum", () => {
    expect(meetsMinVersion("1.5.0", "1.4.3")).toBe(true)
    expect(meetsMinVersion("2.0.0", "1.4.3")).toBe(true)
    expect(meetsMinVersion("1.4.4", "1.4.3")).toBe(true)
  })
  it("returns false when version is below minimum", () => {
    expect(meetsMinVersion("1.4.2", "1.4.3")).toBe(false)
    expect(meetsMinVersion("1.3.9", "1.4.3")).toBe(false)
    expect(meetsMinVersion("0.9.0", "1.4.3")).toBe(false)
  })
  it("returns true for non-semver values (dev builds)", () => {
    expect(meetsMinVersion("local", "1.4.3")).toBe(true)
    expect(meetsMinVersion("dev", "1.4.3")).toBe(true)
  })
  it("returns true when minimum is non-semver", () => {
    expect(meetsMinVersion("1.0.0", "local")).toBe(true)
  })
})
