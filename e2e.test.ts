/**
 * End-to-end tests for opencode-dir plugin commands.
 *
 * These tests launch a real opencode server (headless) with a sandboxed data
 * directory. The server runs drizzle migrations to create the real schema —
 * so we test against opencode's actual database, not a hand-written copy.
 *
 * Flow:
 * 1. Start `opencode serve --pure` with isolated XDG dirs
 * 2. Wait for the server to be ready (poll /session)
 * 3. Create sessions via the HTTP API
 * 4. Run plugin commands (execMove, execAddDir) against the real DB
 * 5. Verify results via both direct DB reads and HTTP API
 * 6. Kill server, clean up sandbox
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { spawn, execSync, type ChildProcess } from "child_process"
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  execMove,
  execAddDir,
  getSessionInfo,
  getCurrentDirectory,
  getSessionPermissions,
  hasSchema,
} from "./lib"

// ── Sandbox ─────────────────────────────────────────────────────────────────

const SANDBOX = mkdtempSync(join(tmpdir(), "ocd-e2e-"))
const DATA_DIR = join(SANDBOX, "data")
const CONFIG_DIR = join(SANDBOX, "config")
const PROJECT_DIR = join(SANDBOX, "project")
const PORT = 19800 + Math.floor(Math.random() * 100)
const SERVER_URL = `http://127.0.0.1:${PORT}`
const OPENCODE_SRC = join(process.env.HOME ?? "", "opencode")

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "e2e",
  GIT_AUTHOR_EMAIL: "e2e@test",
  GIT_COMMITTER_NAME: "e2e",
  GIT_COMMITTER_EMAIL: "e2e@test",
}

let serverProc: ChildProcess | null = null
let dbPath: string

function makeGitRepo(name: string): string {
  const dir = join(SANDBOX, name)
  mkdirSync(dir, { recursive: true })
  execSync("git init && git config commit.gpgsign false && git commit --allow-empty -m init", {
    cwd: dir,
    stdio: "ignore",
    env: GIT_ENV,
  })
  return dir
}

function makePlainDir(name: string): string {
  const dir = join(SANDBOX, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function getCommitHash(dir: string): string {
  return execSync("git rev-list --max-parents=0 HEAD", { cwd: dir }).toString().trim()
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/session`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`)
}

async function apiCreateSession(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(`Failed to create session: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { id: string }
  return data.id
}

async function apiGetSession(id: string): Promise<any> {
  const res = await fetch(`${SERVER_URL}/session/${id}`)
  if (!res.ok) throw new Error(`Failed to get session: ${res.status}`)
  return res.json()
}

async function apiSendMessage(sessionId: string, message: string): Promise<void> {
  // Use promptAsync so we don't block waiting for LLM (no provider configured)
  const res = await fetch(`${SERVER_URL}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: message }] }),
  })
  // Might fail due to no provider — that's OK, we just need the message in the DB
  // The session will have been started and messages seeded
}

function openDb(): Database {
  return new Database(dbPath, { readonly: true })
}

function readSession(sessionId: string) {
  const db = openDb()
  const session = getSessionInfo(db, sessionId)
  const currentDir = getCurrentDirectory(db, sessionId)
  const permissions = getSessionPermissions(db, sessionId)
  db.close()
  return { session, currentDir, permissions }
}

// ── Server lifecycle ────────────────────────────────────────────────────────

beforeAll(async () => {
  // Check opencode source exists
  if (!existsSync(join(OPENCODE_SRC, "packages/opencode"))) {
    throw new Error(`opencode source not found at ${OPENCODE_SRC}. Clone it to ~/opencode to run e2e tests.`)
  }

  // Create sandbox dirs
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(join(CONFIG_DIR, "opencode"), { recursive: true })
  mkdirSync(PROJECT_DIR, { recursive: true })

  // Minimal opencode config — no plugins, no providers
  writeFileSync(
    join(CONFIG_DIR, "opencode", "opencode.json"),
    JSON.stringify({}),
  )

  // Initialize PROJECT_DIR as a git repo (server needs a valid project dir)
  execSync("git init && git config commit.gpgsign false && git commit --allow-empty -m init", {
    cwd: PROJECT_DIR,
    stdio: "ignore",
    env: GIT_ENV,
  })

  // Launch server
  serverProc = spawn(
    "bun",
    ["run", "--filter", "opencode", "dev", "--", "serve", "--port", String(PORT), "--pure"],
    {
      cwd: OPENCODE_SRC,
      env: {
        ...process.env,
        XDG_DATA_HOME: DATA_DIR,
        XDG_CONFIG_HOME: CONFIG_DIR,
        HOME: SANDBOX,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  // Capture output for debugging
  let serverOutput = ""
  serverProc.stdout?.on("data", (d: Buffer) => { serverOutput += d.toString() })
  serverProc.stderr?.on("data", (d: Buffer) => { serverOutput += d.toString() })
  serverProc.on("error", (err: Error) => { console.error("server spawn error:", err) })

  try {
    await waitForServer(SERVER_URL)
  } catch (e) {
    console.error("Server output:", serverOutput)
    throw e
  }

  // Determine DB path — server uses "local" channel when run from source
  const localDb = join(DATA_DIR, "opencode", "opencode-local.db")
  const defaultDb = join(DATA_DIR, "opencode", "opencode.db")
  if (existsSync(localDb)) {
    dbPath = localDb
  } else if (existsSync(defaultDb)) {
    dbPath = defaultDb
  } else {
    throw new Error(`No DB found in ${DATA_DIR}/opencode after server start`)
  }

  // Point our plugin's getDbPath() at the real server DB
  process.env.OPENCODE_DB = dbPath
}, 30000)

afterAll(() => {
  if (serverProc) {
    serverProc.kill("SIGTERM")
    serverProc = null
  }
  delete process.env.OPENCODE_DB
  // Small delay to let server release DB lock
  try { Bun.sleepSync(500) } catch {}
  rmSync(SANDBOX, { recursive: true, force: true })
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe("e2e: server schema validation", () => {
  it("server created a real migrated database", () => {
    const db = openDb()
    expect(hasSchema(db)).toBe(true)
    db.close()
  })

  it("database file exists on disk", () => {
    expect(existsSync(dbPath)).toBe(true)
  })

  it("database has indexes (proves drizzle migrations ran)", () => {
    const db = openDb()
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%session%'")
      .all() as { name: string }[]
    db.close()
    expect(indexes.length).toBeGreaterThan(0)
  })
})

describe("e2e: /cd command against real server DB", () => {
  let sessionId: string
  const repoB = makeGitRepo("cd-target")

  beforeAll(async () => {
    sessionId = await apiCreateSession()
    // Verify session was created via API
    const session = await apiGetSession(sessionId)
    expect(session.id).toBe(sessionId)
  })

  it("changes session directory to a different repo", () => {
    const result = execMove(sessionId, repoB, false)
    expect(result.result).toContain("Session directory changed")
    expect(result.result).toContain(repoB)
    expect(result.newDir).toBe(repoB)
  })

  it("DB reflects the new directory and project", () => {
    const { session } = readSession(sessionId)
    expect(session).not.toBeNull()
    expect(session!.directory).toBe(repoB)
    expect(session!.projectId).toBe(getCommitHash(repoB))
  })

  it("permission rule was written for the target directory", () => {
    const { permissions } = readSession(sessionId)
    expect(permissions).toBeInstanceOf(Array)
    const rule = permissions!.find(
      (r: any) => r.permission === "external_directory" && r.pattern.includes(repoB),
    )
    expect(rule).toBeDefined()
    expect(rule.action).toBe("allow")
  })

  it("API still returns the session after plugin modification", async () => {
    const session = await apiGetSession(sessionId)
    expect(session.id).toBe(sessionId)
    expect(session.directory).toBe(repoB)
  })
})

describe("e2e: /mv command against real server DB", () => {
  let sessionId: string
  const repoTarget = makeGitRepo("mv-target")

  beforeAll(async () => {
    sessionId = await apiCreateSession()
  })

  it("moves session and updates DB", () => {
    const result = execMove(sessionId, repoTarget, true)
    // May or may not have messages to rewrite — session is fresh
    expect(result.result).toMatch(/Session (moved|directory changed)/)
    expect(result.newDir).toBe(repoTarget)
  })

  it("DB reflects the move", () => {
    const { session } = readSession(sessionId)
    expect(session!.directory).toBe(repoTarget)
  })
})

describe("e2e: /add-dir command against real server DB", () => {
  let sessionId: string
  const extraDir = makePlainDir("add-extra")
  const extraDir2 = makeGitRepo("add-extra2")

  beforeAll(async () => {
    sessionId = await apiCreateSession()
  })

  it("grants access to an additional directory", () => {
    const result = execAddDir(sessionId, extraDir)
    expect(result.result).toContain("Added directory")
    expect(result.result).toContain(extraDir)
  })

  it("session directory unchanged", () => {
    const { session } = readSession(sessionId)
    // Session still points to original project dir
    expect(session!.directory).not.toBe(extraDir)
  })

  it("permission rule written for added directory", () => {
    const { permissions } = readSession(sessionId)
    const rule = permissions!.find(
      (r: any) => r.permission === "external_directory" && r.pattern.includes(extraDir),
    )
    expect(rule).toBeDefined()
    expect(rule.action).toBe("allow")
  })

  it("rejects duplicate directory", () => {
    const result = execAddDir(sessionId, extraDir)
    expect(result.result).toContain("already accessible")
  })

  it("allows adding multiple directories", () => {
    const result = execAddDir(sessionId, extraDir2)
    expect(result.result).toContain("Added directory")

    const { permissions } = readSession(sessionId)
    const dirs = permissions!
      .filter((r: any) => r.permission === "external_directory")
      .map((r: any) => r.pattern)
    expect(dirs.length).toBeGreaterThanOrEqual(2)
  })
})

describe("e2e: error paths against real server DB", () => {
  let sessionId: string

  beforeAll(async () => {
    sessionId = await apiCreateSession()
  })

  it("/cd to nonexistent directory returns error", () => {
    const result = execMove(sessionId, "/tmp/does-not-exist-e2e-xyz", false)
    expect(result.result).toContain("Error")
  })

  it("/mv with nonexistent session returns error", () => {
    const dir = makeGitRepo("err-target")
    const result = execMove("nonexistent-session-id", dir, true)
    expect(result.result).toContain("Error")
    expect(result.result).toContain("not found")
  })

  it("/add-dir to nonexistent directory returns error", () => {
    const result = execAddDir(sessionId, "/tmp/does-not-exist-e2e-xyz")
    expect(result.result).toContain("Error")
  })

  it("/add-dir with nonexistent session returns error", () => {
    const dir = makePlainDir("err-extra")
    const result = execAddDir("nonexistent-session-id", dir)
    expect(result.result).toContain("Error")
    expect(result.result).toContain("not found")
  })
})

describe("e2e: cross-command flow against real server DB", () => {
  let sessionId: string
  const repoCd = makeGitRepo("flow-cd")
  const repoMv = makeGitRepo("flow-mv")
  const extraDir = makePlainDir("flow-extra")

  beforeAll(async () => {
    sessionId = await apiCreateSession()
  })

  it("step 1: /cd to new repo", () => {
    const result = execMove(sessionId, repoCd, false)
    expect(result.result).toContain("Session directory changed")
    expect(result.newDir).toBe(repoCd)
  })

  it("step 2: /add-dir for extra access", () => {
    const result = execAddDir(sessionId, extraDir)
    expect(result.result).toContain("Added directory")

    const { session } = readSession(sessionId)
    expect(session!.directory).toBe(repoCd)
  })

  it("step 3: /mv to another repo", () => {
    const result = execMove(sessionId, repoMv, true)
    expect(result.result).toMatch(/Session (moved|directory changed)/)
    expect(result.newDir).toBe(repoMv)
  })

  it("step 4: final state is consistent", () => {
    const { session } = readSession(sessionId)
    expect(session!.directory).toBe(repoMv)
    expect(session!.projectId).toBe(getCommitHash(repoMv))
  })

  it("step 5: API agrees with DB state", async () => {
    const session = await apiGetSession(sessionId)
    expect(session.directory).toBe(repoMv)
  })
})