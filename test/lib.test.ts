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
  rewritePath,
  loadOverrides,
  persistOverrides,
  PATH_TOOLS,
} from "../lib"

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

// ---------------------------------------------------------------------------
// rewritePath
// ---------------------------------------------------------------------------

describe("rewritePath", () => {
  it("rewrites exact match", () => {
    expect(rewritePath("/old", "/old", "/new")).toBe("/new")
  })

  it("rewrites prefix match", () => {
    expect(rewritePath("/old/sub/file.ts", "/old", "/new")).toBe("/new/sub/file.ts")
  })

  it("leaves unrelated paths unchanged", () => {
    expect(rewritePath("/other/file.ts", "/old", "/new")).toBe("/other/file.ts")
  })

  it("does not rewrite partial directory name matches", () => {
    expect(rewritePath("/old-stuff/file.ts", "/old", "/new")).toBe("/old-stuff/file.ts")
  })
})

// ---------------------------------------------------------------------------
// loadOverrides / persistOverrides
// ---------------------------------------------------------------------------

describe("overrides persistence", () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = join(mkdtempSync(join(tmpdir(), "ocd-ovr-")), "overrides.json")
  })

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
    const stat = Bun.file(tmpFile)
    // Bun.file doesn't expose mode, check via fs
    const { statSync } = require("fs")
    const mode = statSync(tmpFile).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

// ---------------------------------------------------------------------------
// getInitialCommit
// ---------------------------------------------------------------------------

describe("getInitialCommit", () => {
  let repo: string

  beforeEach(() => {
    repo = createGitRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it("returns the root commit hash", () => {
    const hash = getInitialCommit(repo)
    expect(hash).toBeString()
    expect(hash!.length).toBe(40)
  })

  it("returns null for non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocd-nogit-"))
    expect(getInitialCommit(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

describe("resolveTarget", () => {
  let repo: string

  beforeEach(() => {
    repo = createGitRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it("resolves a git repo to dir and projectId", () => {
    const result = resolveTarget(repo)
    expect(result.dir).toBe(repo)
    expect(result.projectId.length).toBe(40)
  })

  it("throws for nonexistent directory", () => {
    expect(() => resolveTarget("/no/such/path/xyz")).toThrow("does not exist")
  })

  it("throws for non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocd-nogit-"))
    expect(() => resolveTarget(dir)).toThrow("not inside a git repository")
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Database functions
// ---------------------------------------------------------------------------

describe("ensureProject", () => {
  it("creates a project row", () => {
    const db = createTestDb()
    ensureProject(db, "proj_1", "/work")
    const row = db.query("SELECT * FROM project WHERE id = ?").get("proj_1") as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row.worktree).toBe("/work")
    expect(row.vcs).toBe("git")
    db.close()
  })

  it("is idempotent", () => {
    const db = createTestDb()
    ensureProject(db, "proj_1", "/work")
    ensureProject(db, "proj_1", "/work")
    const count = db.query("SELECT COUNT(*) as c FROM project WHERE id = ?").get("proj_1") as { c: number }
    expect(count.c).toBe(1)
    db.close()
  })
})

describe("updateSession", () => {
  it("updates directory, project_id, and permission", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_old", "/old")
    ensureProject(db, "proj_new", "/new")
    const changes = updateSession(db, "ses_1", "/new", "proj_new")
    expect(changes).toBe(1)

    const row = db.query("SELECT * FROM session WHERE id = ?").get("ses_1") as Record<string, unknown>
    expect(row.directory).toBe("/new")
    expect(row.project_id).toBe("proj_new")

    const permission = JSON.parse(row.permission as string)
    expect(permission).toEqual([
      { permission: "external_directory", pattern: "/new/*", action: "allow" },
    ])
    db.close()
  })

  it("returns 0 for nonexistent session", () => {
    const db = createTestDb()
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
    stubSession(db, "ses_1", "proj_1", "/fallback")
    stubMessage(db, "msg_1", "ses_1", { role: "user" })
    stubMessage(db, "msg_2", "ses_1", { role: "assistant", path: { cwd: "/actual", root: "/actual" } })
    expect(getCurrentDirectory(db, "ses_1")).toBe("/actual")
    db.close()
  })

  it("returns null when no messages have path info", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/work")
    stubMessage(db, "msg_1", "ses_1", { role: "user" })
    expect(getCurrentDirectory(db, "ses_1")).toBeNull()
    db.close()
  })
})

describe("rewriteMessages", () => {
  it("rewrites path.cwd and path.root in messages", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/old")
    stubMessage(db, "msg_1", "ses_1", { role: "assistant", path: { cwd: "/old", root: "/old" } })
    stubMessage(db, "msg_2", "ses_1", { role: "assistant", path: { cwd: "/old", root: "/old" } })
    stubMessage(db, "msg_3", "ses_1", { role: "user" })

    const result = rewriteMessages(db, "ses_1", "/old", "/new")
    expect(result.total).toBe(3)
    expect(result.rewritten).toBe(2)

    const row = db.query("SELECT data FROM message WHERE id = ?").get("msg_1") as { data: string }
    const data = JSON.parse(row.data)
    expect(data.path.cwd).toBe("/new")
    expect(data.path.root).toBe("/new")
    db.close()
  })

  it("leaves messages without path unchanged", () => {
    const db = createTestDb()
    stubSession(db, "ses_1", "proj_1", "/old")
    stubMessage(db, "msg_1", "ses_1", { role: "user", text: "hello" })

    const result = rewriteMessages(db, "ses_1", "/old", "/new")
    expect(result.total).toBe(1)
    expect(result.rewritten).toBe(0)

    const row = db.query("SELECT data FROM message WHERE id = ?").get("msg_1") as { data: string }
    expect(JSON.parse(row.data).text).toBe("hello")
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
    stubSession(db, "ses_1", "proj_src", "/src")
    stubMessage(db, "msg_1", "ses_1", { role: "assistant", path: { cwd: "/src", root: "/src" } })

    const result = execMove("ses_1", repo, false, db)
    expect(result.oldDir).toBe("/src")
    expect(result.newDir).toBe(repo)
    expect(result.result).toContain("Session directory changed")
    expect(result.result).not.toContain("rewritten")

    // Session updated
    const session = getSessionInfo(db, "ses_1")!
    expect(session.directory).toBe(repo)
    expect(session.projectId).toBe(projectId)

    // Messages NOT rewritten
    const row = db.query("SELECT data FROM message WHERE id = ?").get("msg_1") as { data: string }
    expect(JSON.parse(row.data).path.cwd).toBe("/src")
  })

  it("mv: updates session AND rewrites messages", () => {
    stubSession(db, "ses_1", "proj_src", "/src")
    stubMessage(db, "msg_1", "ses_1", { role: "assistant", path: { cwd: "/src", root: "/src" } })

    const result = execMove("ses_1", repo, true, db)
    expect(result.oldDir).toBe("/src")
    expect(result.result).toContain("Session moved")
    expect(result.result).toContain("1/1 rewritten")

    // Messages rewritten
    const row = db.query("SELECT data FROM message WHERE id = ?").get("msg_1") as { data: string }
    expect(JSON.parse(row.data).path.cwd).toBe(repo)
  })

  it("rejects global project sessions", () => {
    stubSession(db, "ses_1", "global", "/tmp")

    const result = execMove("ses_1", repo, false, db)
    expect(result.result).toContain("global")
    expect(result.oldDir).toBeUndefined()
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
    expect(result.oldDir).toBeUndefined()
  })

  it("writes session permission for target directory", () => {
    stubSession(db, "ses_1", "proj_src", "/src")

    execMove("ses_1", repo, false, db)

    const row = db.query("SELECT permission FROM session WHERE id = ?").get("ses_1") as { permission: string }
    const rules = JSON.parse(row.permission)
    expect(rules).toEqual([
      { permission: "external_directory", pattern: repo + "/*", action: "allow" },
    ])
  })

  it("creates target project if it does not exist", () => {
    const projectId = getInitialCommit(repo)!
    stubSession(db, "ses_1", "proj_src", "/src")

    execMove("ses_1", repo, false, db)

    const project = db.query("SELECT * FROM project WHERE id = ?").get(projectId) as Record<string, unknown>
    expect(project).toBeTruthy()
    expect(project.worktree).toBe(repo)
  })
})

// ---------------------------------------------------------------------------
// PATH_TOOLS
// ---------------------------------------------------------------------------

describe("PATH_TOOLS", () => {
  it("maps known tools to their path arg keys", () => {
    expect(PATH_TOOLS.read).toEqual(["filePath"])
    expect(PATH_TOOLS.write).toEqual(["filePath"])
    expect(PATH_TOOLS.edit).toEqual(["filePath"])
    expect(PATH_TOOLS.glob).toEqual(["path"])
    expect(PATH_TOOLS.grep).toEqual(["path"])
    expect(PATH_TOOLS.bash).toEqual(["workdir"])
  })

  it("does not include tools without path args", () => {
    expect(PATH_TOOLS.webfetch).toBeUndefined()
    expect(PATH_TOOLS.task).toBeUndefined()
  })
})
