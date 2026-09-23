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
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Database } from "./db"
import { spawn, execSync, type ChildProcess } from "child_process"
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, realpathSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createServer, type Server, type ServerResponse } from "http"
import {
  execMove,
  execAddDir,
  getSessionInfo,
  getCurrentDirectory,
  getSessionPermissions,
  hasSchema,
  isGenerating,
  rewriteMessages,
} from "./lib"

// ── Sandbox ─────────────────────────────────────────────────────────────────

const SANDBOX = mkdtempSync(join(tmpdir(), "ocd-e2e-"))
const DATA_DIR = join(SANDBOX, "data")
const CONFIG_DIR = join(SANDBOX, "config")
const PROJECT_DIR = join(SANDBOX, "project")
const PORT = 30000 + Math.floor(Math.random() * 30000)
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
let fakeProvider: FakeProvider | null = null
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

async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
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

/** Check that a port is free by trying to listen on it briefly. */
async function assertPortFree(port: number): Promise<void> {
  const net = await import("net")
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", (err: NodeJS.ErrnoException) => {
      reject(new Error(`Port ${port} is already in use: ${err.code}`))
    })
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve())
    })
  })
}

/** Kill the server process with SIGTERM, escalating to SIGKILL after 3s. */
function killServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverProc) return resolve()
    const proc = serverProc
    serverProc = null

    let resolved = false
    const done = () => {
      if (resolved) return
      resolved = true
      resolve()
    }

    proc.on("exit", done)
    proc.on("error", done)

    // Try graceful SIGTERM first
    proc.kill("SIGTERM")

    // Escalate to SIGKILL after 3 seconds
    setTimeout(() => {
      try { proc.kill("SIGKILL") } catch {}
      // Give SIGKILL 1s to take effect, then resolve anyway
      setTimeout(done, 1000)
    }, 3000)
  })
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

async function apiGetSession(id: string): Promise<{ id: string; directory: string }> {
  const res = await fetch(`${SERVER_URL}/session/${id}`)
  if (!res.ok) throw new Error(`Failed to get session: ${res.status}`)
  return res.json()
}

async function apiSendMessage(sessionId: string, message: string): Promise<void> {
  // async prompt — the fake provider starts an in-flight turn we can test against
  await fetch(`${SERVER_URL}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: message }] }),
  })
}

async function apiAbort(sessionId: string): Promise<Response> {
  return await fetch(`${SERVER_URL}/session/${sessionId}/abort`, { method: "POST" })
}

async function apiCommand(sessionId: string, command: string, args: string): Promise<Response> {
  return await fetch(`${SERVER_URL}/session/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, arguments: args }),
  })
}

async function expectCommandOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    throw new Error(
      `${label} failed: ${res.status} ${await res.text()}\n--- server output ---\n${serverOutput}`,
    )
  }
}

async function waitUntil(
  desc: string,
  fn: () => boolean,
  timeoutMs = 15000,
  intervalMs = 250,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out waiting for: ${desc}\n--- server output ---\n${serverOutput}`)
}

function assistantRows(db: Database, sessionId: string): { id: string; data: Record<string, unknown> }[] {
  const rows = db.query("SELECT id, data FROM message WHERE session_id = ?").all(sessionId) as {
    id: string
    data: string
  }[]
  return rows
    .filter((r) => {
      const data = JSON.parse(r.data) as Record<string, unknown>
      return data.role === "assistant"
    })
    .map((r) => ({ id: r.id, data: JSON.parse(r.data) as Record<string, unknown> }))
}

function openDb(): Database {
  return new Database(dbPath)
}

function readSession(sessionId: string) {
  const db = openDb()
  const session = getSessionInfo(db, sessionId)
  const currentDir = getCurrentDirectory(db, sessionId)
  const permissions = getSessionPermissions(db, sessionId)
  db.close()
  return { session, currentDir, permissions }
}

// ── Fake OpenAI-compatible provider ─────────────────────────────────────────
// Streams a slow deterministic reply so tests have a real in-flight turn to
// run commands against. opencode reaches it via a config declared provider
// (bundled @ai-sdk/openai-compatible, fully offline).

class FakeProvider {
  private server: Server
  private readonly delayMs = 400
  port = 0

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const collect = (cb: (body: string) => void) => {
        let body = ""
        req.on("data", (c: Buffer) => (body += c.toString()))
        req.on("end", () => cb(body))
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
        collect((body) => {
          let title = false
          try { title = (JSON.parse(body).messages?.[0]?.content ?? "").startsWith("Generate a title") } catch {}
          this.emitChat(res, title ? 0 : 26)
        })
        return
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model", created: 0, owned_by: "mock" }] }))
        return
      }
      res.statusCode = 404
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ error: { message: "not found" } }))
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
    const addr = this.server.address()
    if (addr && typeof addr === "object") this.port = addr.port
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private emitChat(res: ServerResponse, tokens: number) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    const created = Math.floor(Date.now() / 1000)
    const chunk = (content: string, finish: string | null) => ({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created,
      model: "mock-model",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }],
    })
    let i = 0
    const send = () => {
      if (i >= tokens) {
        res.write(`data: ${JSON.stringify(chunk("", "stop"))}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify(chunk(`tok ${i} `, null))}\n\n`)
      i++
      setTimeout(send, tokens === 0 ? 0 : this.delayMs)
    }
    send()
  }
}

let serverOutput = ""

// ── Server lifecycle ────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.OPENCODE_DIR_TEST = "1"
  // Ensure port is free before starting (prevents collisions from zombie servers)
  await assertPortFree(PORT)

  // Check opencode source exists
  if (!existsSync(join(OPENCODE_SRC, "packages/opencode"))) {
    throw new Error(`opencode source not found at ${OPENCODE_SRC}. Clone it to ~/opencode to run e2e tests.`)
  }

  // Create sandbox dirs
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(join(CONFIG_DIR, "opencode"), { recursive: true })
  mkdirSync(PROJECT_DIR, { recursive: true })

  // Fake provider must be up before config is written (config needs its port)
  fakeProvider = new FakeProvider()
  await fakeProvider.start()
  const provProbe = await fetch(`http://127.0.0.1:${fakeProvider.port}/v1/models`)
  if (!provProbe.ok) throw new Error(`fake provider not reachable: ${provProbe.status} ${await provProbe.text()}`)

  // Sandbox config: fake provider + opencode-dir plugin, so command hooks run
  // against a real live server. Provider api = baseURL known to openai-compatible.
  writeFileSync(
    join(CONFIG_DIR, "opencode", "opencode.json"),
    JSON.stringify({
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          name: "Mock",
          api: `http://127.0.0.1:${fakeProvider.port}/v1`,
          options: { apiKey: "test-key" },
          models: { "mock-model": { name: "Mock Model" } },
        },
      },
      model: "mock/mock-model",
      plugin: [process.cwd()],
    }),
  )

  // Initialize PROJECT_DIR as a git repo (server needs a valid project dir)
  execSync("git init && git config commit.gpgsign false && git commit --allow-empty -m init", {
    cwd: PROJECT_DIR,
    stdio: "ignore",
    env: GIT_ENV,
  })

  // Launch server — use built opencode binary, not bun filter. No --pure so the
  // plugin configured above actually loads.
  const bin = process.env.OPENCODE_BIN || join(process.env.HOME ?? "", ".opencode/bin/opencode")
  const cmd = existsSync(bin) ? bin : "opencode"
  serverProc = spawn(cmd, ["serve", "--port", String(PORT)], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      XDG_DATA_HOME: DATA_DIR,
      XDG_CONFIG_HOME: CONFIG_DIR,
      HOME: SANDBOX,
      OPENCODE_DIR_TEST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  // Capture output for debugging
  serverOutput = ""
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
}, 120000)

// ── Crash-proof cleanup: kill server on ANY exit ─────────────────────────────
const cleanup = () => { killServer().catch(() => {}) }
process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit(130) })
process.on("SIGTERM", () => { cleanup(); process.exit(143) })
process.on("uncaughtException", (err) => { console.error(err); cleanup(); process.exit(1) })

afterAll(async () => {
  await killServer()
  if (fakeProvider) await fakeProvider.close().catch(() => {})
  fakeProvider = null
  delete process.env.OPENCODE_DB
  // Give the OS a moment to release the port before sandbox removal
  await new Promise((r) => setTimeout(r, 500))
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
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
    const rule = (permissions as Array<{ permission: string; pattern: string; action: string }>).find(
      (r) => r.permission === "external_directory" && r.pattern.includes(repoB),
    )
    expect(rule).toBeDefined()
    expect(rule!.action).toBe("allow")
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
    const rule = (permissions as Array<{ permission: string; pattern: string; action: string }>).find(
      (r) => r.permission === "external_directory" && r.pattern.includes(extraDir),
    )
    expect(rule).toBeDefined()
    expect(rule!.action).toBe("allow")
  })

  it("rejects duplicate directory", () => {
    const result = execAddDir(sessionId, extraDir)
    expect(result.result).toContain("already accessible")
  })

  it("allows adding multiple directories", () => {
    const result = execAddDir(sessionId, extraDir2)
    expect(result.result).toContain("Added directory")

    const { permissions } = readSession(sessionId)
    const dirs = (permissions as Array<{ permission: string; pattern: string }>)
      .filter((r) => r.permission === "external_directory")
      .map((r) => r.pattern)
    expect(dirs.length).toBeGreaterThanOrEqual(2)
  })
})

describe("e2e: /remove-dir command against real server DB", () => {
  let sessionId: string
  const extra = makePlainDir("remove-extra")
  beforeAll(async () => { sessionId = await apiCreateSession(); execAddDir(sessionId, extra) })
  it("removes added directory", async () => {
    const { execRemoveDir } = await import("./lib")
    const r = execRemoveDir(sessionId, extra)
    expect(r.result).toContain("Removed")
  })
  it("permission removed", () => {
    const { permissions } = readSession(sessionId)
    const rule = (permissions as Array<{ pattern: string }>).find((r) => r.pattern.includes(extra))
    expect(rule).toBeUndefined()
  })
})

describe("e2e: /vault against real server DB", () => {
  let sessionId: string
  beforeAll(async () => { sessionId = await apiCreateSession() })
  it("vault init/open/close flow", async () => {
    const dir = makePlainDir("vault-e2e")
    const { writeFileSync } = await import("fs")
    writeFileSync(join(dir, "secret.txt"), "hi")
    const { vaultInit, vaultOpen, vaultClose } = await import("./lib.vault")
    const init = vaultInit(dir, "pass123")
    expect(init.ok).toBe(true)
    const open = vaultOpen(new Database(process.env.OPENCODE_DB!), sessionId, dir, "pass123")
    expect(open.ok).toBe(true)
    const close = vaultClose(new Database(process.env.OPENCODE_DB!), sessionId, dir, "pass123")
    expect(close.ok).toBe(true)
  })
})

describe("e2e: error paths against real server DB", () => {
  let sessionId: string

  beforeAll(async () => {
    sessionId = await apiCreateSession()
  })

  it("/cd to nonexistent directory returns error", () => {
    const result = execMove(sessionId, "/tmp/does-not-exist-e2e-xyz", false)
    expect(result.status).toBe("error")
    expect(result.result).toContain("does not exist")
  })

  it("/mv with nonexistent session returns error", () => {
    const dir = makeGitRepo("err-target")
    const result = execMove("nonexistent-session-id", dir, true)
    expect(result.status).toBe("error")
    expect(result.result).toContain("not found")
  })

  it("/add-dir to nonexistent directory returns error", () => {
    const result = execAddDir(sessionId, "/tmp/does-not-exist-e2e-xyz")
    expect(result.status).toBe("error")
    expect(result.result).toContain("does not exist")
  })

  it("/add-dir with nonexistent session returns error", () => {
    const dir = makePlainDir("err-extra")
    const result = execAddDir("nonexistent-session-id", dir)
    expect(result.status).toBe("error")
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
// ── Mid-turn scenarios ──────────────────────────────────────────────────────
// Everything above runs commands against idle sessions. The issue-#28 class of
// bugs surfaced only when a command landed while a turn was generating, so
// these tests drive real streaming turns (via the fake provider) and issue the
// plugin's functions/commands mid-flight.

describe("e2e: mid-turn execMove refuses while generating", () => {
  let sessionId: string
  let db: Database
  const target = makeGitRepo("mt-refuse-target")

  beforeAll(async () => {
    sessionId = await apiCreateSession()
    db = openDb()
    await apiSendMessage(sessionId, "Write a long story and keep going until I say stop.")
    await waitUntil("turn to start generating", () => isGenerating(db, sessionId), 25000)
  }, 90000)

  afterAll(() => {
    db.close()
    return apiAbort(sessionId).catch(() => {})
  })

  it("refuses to move while an assistant turn is streaming", () => {
    const result = execMove(sessionId, target, true)
    expect(result.result).toMatch(/currently generating/i)
  }, 30000)
})

describe("e2e: mid-turn rewriteMessages skips the streaming row", () => {
  let sessionId: string
  let db: Database

  beforeAll(async () => {
    sessionId = await apiCreateSession()
    db = openDb()
    await apiSendMessage(sessionId, "Keep narrating for a while, do not stop.")
    await waitUntil("turn to start generating", () => isGenerating(db, sessionId), 25000)
  }, 90000)

  afterAll(() => {
    db.close()
    return apiAbort(sessionId).catch(() => {})
  })

  it("leaves the live assistant row untouched and reports it skipped", () => {
    const live = assistantRows(db, sessionId).find(
      (a) => a.data.time && (a.data.time as { completed?: number }).completed === undefined,
    )
    expect(live).toBeTruthy()

    const livePath = (live!.data.path as { cwd?: string } | undefined)?.cwd
    const { total, rewritten, skipped } = rewriteMessages(db, sessionId, "/no-such-mt-dir", "/other-mt-dir")

    expect(skipped).toBe(1)
    expect(rewritten).toBe(0)
    expect(total).toBeGreaterThanOrEqual(2)

    const after = assistantRows(db, sessionId)
    const liveAfter = after.find((a) => a.id === live!.id)
    expect(liveAfter).toBeTruthy()
    const afterPath = (liveAfter!.data.path as { cwd?: string } | undefined)?.cwd
    if (livePath !== undefined) expect(afterPath).toBe(livePath)
  }, 30000)
})

describe("e2e: /mv; command hook cancels the live turn and lands the move", () => {
  let sessionId: string
  let db: Database
  const target = makeGitRepo("cmd-mv-target")

  beforeAll(async () => {
    sessionId = await apiCreateSession()
    db = openDb()
    await apiSendMessage(sessionId, "Do not stop writing until told otherwise.")
    await waitUntil("turn to start generating", () => isGenerating(db, sessionId), 25000)
  }, 90000)

  afterAll(() => {
    db.close()
    return apiAbort(sessionId).catch(() => {})
  })

  it("aborts the turn, settles, moves the session, and keeps history consistent", async () => {
    const res = await apiCommand(sessionId, "mv", target)
    await expectCommandOk(res, "/mv mid-turn")

    await waitUntil("turn to settle after /mv", () => !isGenerating(db, sessionId), 30000)

    const { session } = readSession(sessionId)
    expect(session!.directory).toBe(target)

    const rows = db.query("SELECT data FROM message WHERE session_id = ?").all(sessionId) as { data: string }[]
    const all = rows.map((r) => JSON.parse(r.data) as { role?: string; time?: { completed?: number }; path?: { cwd?: string } })
    const assistants = all.filter((d) => d.role === "assistant")
    expect(assistants.length).toBeGreaterThanOrEqual(1)
    for (const a of assistants) expect(a.time!.completed).not.toBeUndefined()

    const cwds = new Set(all.flatMap((d) => (d.path?.cwd ? [realpathSync(d.path.cwd)] : [])))
    expect(cwds.size).toBeLessThanOrEqual(2)
    expect(cwds).toContain(realpathSync(target))
    for (const c of cwds) {
      expect([realpathSync(target), realpathSync(PROJECT_DIR)]).toContain(c)
    }
  }, 120000)
})

describe("e2e: /cd; command hook cancels the live turn and lands without rewriting history", () => {
  let sessionId: string
  let db: Database
  const target = makeGitRepo("cmd-cd-target")

  beforeAll(async () => {
    sessionId = await apiCreateSession()
    db = openDb()
    await apiSendMessage(sessionId, "Keep going, do not stop.")
    await waitUntil("turn to start generating", () => isGenerating(db, sessionId), 25000)
  }, 90000)

  afterAll(() => {
    db.close()
    return apiAbort(sessionId).catch(() => {})
  })

  it("aborts, settles, and changes directory while message history keeps its paths", async () => {
    const res = await apiCommand(sessionId, "cd", target)
    await expectCommandOk(res, "/cd mid-turn")

    await waitUntil("turn to settle after /cd", () => !isGenerating(db, sessionId), 30000)

    const { session } = readSession(sessionId)
    expect(session!.directory).toBe(target)

    const rows = db.query("SELECT data FROM message WHERE session_id = ?").all(sessionId) as { data: string }[]
    const all = rows.map((r) => JSON.parse(r.data) as { role?: string; time?: { completed?: number }; path?: { cwd?: string } })
    const assistants = all.filter((d) => d.role === "assistant")
    expect(assistants.length).toBeGreaterThanOrEqual(1)
    for (const a of assistants) expect(a.time!.completed).not.toBeUndefined()

    const cwds = new Set(all.flatMap((d) => (d.path?.cwd ? [realpathSync(d.path.cwd)] : [])))
    expect(cwds.size).toBe(1)
    expect([...cwds][0]).toBe(realpathSync(PROJECT_DIR))
  }, 120000)
})

describe("e2e: /add-dir; command hook cancels the live turn and grants access", () => {
  let sessionId: string
  let db: Database
  const target = makeGitRepo("cmd-adddir-target")

  beforeAll(async () => {
    sessionId = await apiCreateSession()
    db = openDb()
    await apiSendMessage(sessionId, "Do not stop until I say so.")
    await waitUntil("turn to start generating", () => isGenerating(db, sessionId), 25000)
  }, 90000)

  afterAll(() => {
    db.close()
    return apiAbort(sessionId).catch(() => {})
  })

  it("aborts, settles, grants the permission, and leaves the directory alone", async () => {
    const res = await apiCommand(sessionId, "add-dir", target)
    await expectCommandOk(res, "/add-dir mid-turn")

    await waitUntil("turn to settle after /add-dir", () => !isGenerating(db, sessionId), 30000)

    const { session, currentDir, permissions } = readSession(sessionId)
    expect(currentDir).toBe(realpathSync(PROJECT_DIR))
    expect(session!.directory).toBe(realpathSync(PROJECT_DIR))

    const rule = (permissions as Array<{ permission: string; pattern: string; action: string }>).find(
      (r) => r.permission === "external_directory" && r.pattern.includes(target),
    )
    expect(rule).toBeDefined()
    expect(rule!.action).toBe("allow")

    const assistants = assistantRows(db, sessionId)
    expect(assistants.length).toBeGreaterThanOrEqual(1)
    for (const a of assistants) expect((a.data.time as { completed?: number }).completed).not.toBeUndefined()
  }, 120000)
})
