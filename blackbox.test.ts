import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Database } from "./db"
import { spawn, execSync, type ChildProcess } from "child_process"
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, realpathSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createServer, type Server, type ServerResponse } from "http"
import { getSessionPermissions } from "./lib"

const GLOBAL_CONFIG_HOME = process.env.OPENCODE_CONFIG_HOME || join(process.env.HOME ?? "", ".config")

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "blackbox",
  GIT_AUTHOR_EMAIL: "blackbox@test",
  GIT_COMMITTER_NAME: "blackbox",
  GIT_COMMITTER_EMAIL: "blackbox@test",
}

export type Rule = { action?: string; resource?: string; effect?: string; permission?: string; pattern?: string }

function ruleAction(r: Rule): string {
  return r.permission ?? r.action ?? ""
}

function ruleResource(r: Rule): string {
  return r.resource ?? r.pattern ?? ""
}

type RuleReader = (sessionID: string) => Rule[]
type AsyncRuleReader = (sessionID: string) => Promise<Rule[]>

interface Runtime {
  id: string
  binary: string
  table: string
  start: (sandbox: Sandbox) => Promise<Session>
}

interface Session {
  create: () => Promise<string>
  run: (sessionID: string, name: string, args: string) => Promise<void>
  apiDirectory: (sessionID: string) => Promise<string>
  apiPermissions: AsyncRuleReader
  dbDirectory: (sessionID: string) => Promise<string>
  dbPermissions: RuleReader
  output: () => string
  stop: () => Promise<void>
}

interface Sandbox {
  root: string
  data: string
  config: string
  project: string
  repoA: string
  repoB: string
  extra: string
  target: string
  file: string
}

function resolvePath(p: string): string {
  return existsSync(p) ? realpathSync(p) : p
}

function makeSandbox(name: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `ocd-blackbox-${name}-`))
  const data = join(root, "data")
  const config = join(root, "config")
  const project = join(root, "project")
  const repoA = join(root, "repoA")
  const repoB = join(root, "repoB")
  const extra = join(root, "extra")
  const target = join(root, "target")
  for (const d of [data, config, project, repoA, repoB, extra, target]) mkdirSync(d, { recursive: true })
  const file = join(root, "afile.txt")
  writeFileSync(file, "not a directory\n")
  for (const d of [project, repoA, repoB]) {
    execSync("git init -q && git config commit.gpgsign false && git commit -q --allow-empty -m init", {
      cwd: d,
      stdio: "ignore",
      env: GIT_ENV,
    })
  }
  return {
    root,
    data,
    config,
    project,
    repoA: resolvePath(repoA),
    repoB: resolvePath(repoB),
    extra: resolvePath(extra),
    target: resolvePath(target),
    file: resolvePath(file),
  }
}

async function assertPortFree(port: number): Promise<void> {
  const net = await import("net")
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", (err: NodeJS.ErrnoException) => reject(new Error(`port ${port} busy: ${err.code}`)))
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()))
  })
}

const T0 = Date.now()
function log(...a: unknown[]): void {
  console.log(`[+${String(Date.now() - T0).padStart(6)}ms]`, ...a)
}

async function waitUntil(desc: string, fn: () => boolean | Promise<boolean>, timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await fn()) {
      log(`OK   waitUntil(${desc})`)
      return
    }
    if (Date.now() - start > timeoutMs) {
      log(`FAIL waitUntil(${desc}) — exceeded ${timeoutMs}ms`)
      throw new Error(`timed out: ${desc}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

function kill(proc: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!proc) return resolve()
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    proc.on("exit", done)
    proc.on("error", done)
    try {
      proc.kill("SIGTERM")
    } catch {}
    setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {}
      setTimeout(done, 500)
    }, 3000)
  })
}

const spawned = new Set<ChildProcess>()

function spawnServer(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  onLine: (line: string) => void,
): { proc: ChildProcess; output: () => string } {
  let buffer = ""
  const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
  spawned.add(proc)
  const capture = (d: Buffer) => {
    buffer += d.toString()
    for (const line of buffer.split("\n")) if (line.trim()) onLine(line)
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1)
  }
  proc.stdout?.on("data", capture)
  proc.stderr?.on("data", capture)
  proc.on("exit", () => spawned.delete(proc))
  return { proc, output: () => buffer }
}

function killAllSync(): void {
  for (const proc of spawned) {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }
  spawned.clear()
}

process.on("exit", killAllSync)
process.on("SIGINT", () => {
  killAllSync()
  process.exit(130)
})
process.on("SIGTERM", () => {
  killAllSync()
  process.exit(143)
})
process.on("uncaughtException", (err) => {
  console.error(err)
  killAllSync()
  process.exit(1)
})

function openDb(path: string): Database {
  return new Database(path)
}

class FakeProvider {
  private server: Server
  requests = 0
  port = 0

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        this.requests++
        let body = ""
        req.on("data", (c: Buffer) => (body += c.toString()))
        req.on("end", () => {
          let title = false
          try {
            title = (JSON.parse(body).messages?.[0]?.content ?? "").startsWith("Generate a title")
          } catch {}
          this.emitChat(res, title ? 0 : 1)
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
      setTimeout(send, 0)
    }
    send()
  }
}

let fakeProvider: FakeProvider | undefined

function providerOverlayJson(): string {
  if (!fakeProvider) throw new Error("fake provider not started")
  return JSON.stringify({
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
  })
}

function externalRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => ruleAction(r) === "external_directory")
}

function covers(rules: Rule[], dir: string): boolean {
  const trimmed = dir.replace(/\/+$/, "")
  return externalRules(rules).some((r) => {
    const base = ruleResource(r).replace(/\/\*$/, "")
    if (!base) return false
    return base === trimmed || base === resolvePath(trimmed) || trimmed === resolvePath(base)
  })
}

function v1Runtime(binary: string): Runtime {
  return {
    id: "v1",
    binary,
    table: "session",
    start: async (box) => {
      const port = 31000 + Math.floor(Math.random() * 20000)
      await assertPortFree(port)
      const url = `http://127.0.0.1:${port}`
      log(`v1 starting: ${binary} on port ${port} in ${box.project}`)
      const { proc, output } = spawnServer(
        binary,
        ["serve", "--port", String(port)],
        box.project,
        {
          XDG_DATA_HOME: box.data,
          XDG_CONFIG_HOME: GLOBAL_CONFIG_HOME,
          HOME: box.root,
          OPENCODE_DIR_TEST: "1",
          OPENCODE_CONFIG_CONTENT: providerOverlayJson(),
        },
        (line) => log(`v1> ${line}`),
      )
      await waitUntil("v1 server ready", async () => {
        try {
          const res = await fetch(`${url}/session`)
          return res.ok
        } catch {
          return false
        }
      })
      let dbPath: string | undefined
      await waitUntil("v1 db", async () => {
        dbPath = [join(box.data, "opencode", "opencode-local.db"), join(box.data, "opencode", "opencode.db")].find(
          existsSync,
        )
        return Boolean(dbPath)
      })
      if (!dbPath) throw new Error(`v1: no db under ${box.data}`)
      const v1db = dbPath
      log(`v1 db: ${v1db}`)
      process.env.OPENCODE_DB = v1db
      const readRules: RuleReader = (sessionID) => {
        const db = openDb(v1db)
        const rules = getSessionPermissions(db, sessionID) as Rule[]
        db.close()
        return rules
      }
      const apiRules = async (sessionID: string): Promise<Rule[]> => {
        const res = await fetch(`${url}/session/${sessionID}`)
        const data = (await res.json()) as { permission?: unknown }
        const raw = data.permission
        if (!raw) return []
        if (typeof raw === "string") {
          try {
            return JSON.parse(raw) as Rule[]
          } catch {
            return []
          }
        }
        return raw as Rule[]
      }
      return {
        create: async () => {
          log("v1 create: POST /session ...")
          const res = await fetch(`${url}/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
          const raw = await res.text()
          log(`v1 create -> ${res.status} ${raw.slice(0, 160)}`)
          if (!res.ok) throw new Error(`v1 create failed ${res.status}`)
          const data = JSON.parse(raw) as { id: string }
          return data.id
        },
        run: async (sessionID, name, args) => {
          const res = await fetch(`${url}/session/${sessionID}/command`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: name, arguments: args }),
          })
          const body = await res.text()
          log(`CMD ${name} -> ${res.status} ${body.slice(0, 200)}`)
        },
        apiDirectory: async (sessionID) => {
          const res = await fetch(`${url}/session/${sessionID}`)
          const data = (await res.json()) as { directory: string }
          return resolvePath(data.directory)
        },
        apiPermissions: apiRules,
        dbDirectory: async (sessionID) => {
          const db = openDb(v1db)
          const row = db.query(`SELECT directory FROM session WHERE id = ?`).get(sessionID) as
            | { directory: string }
            | undefined
          db.close()
          return resolvePath(row?.directory ?? "")
        },
        dbPermissions: readRules,
        output,
        stop: async () => {
          await kill(proc)
          delete process.env.OPENCODE_DB
        },
      }
    },
  }
}

function v2Runtime(binary: string): Runtime {
  return {
    id: "v2",
    binary,
    table: "session_v2",
    start: async (box) => {
      const port = 31000 + Math.floor(Math.random() * 20000)
      await assertPortFree(port)
      const url = `http://127.0.0.1:${port}`
      let password = ""
      const { proc, output } = spawnServer(
        binary,
        ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
        box.project,
        {
          XDG_DATA_HOME: box.data,
          XDG_CONFIG_HOME: GLOBAL_CONFIG_HOME,
          HOME: box.root,
          OPENCODE_CONFIG_CONTENT: providerOverlayJson(),
        },
        (line) => {
          const m = /^server password (\S+)/.exec(line.trim())
          if (m) password = m[1]
        },
      )
      await waitUntil("v2 password", () => password.length > 0)
      await waitUntil("v2 server ready", async () => {
        try {
          const res = await fetch(`${url}/api/session`, { headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
          return res.ok
        } catch {
          return false
        }
      })
      const dbPath = join(box.data, "opencode", "opencode.db")
      await waitUntil("v2 db", () => existsSync(dbPath))
      const readCol: RuleReader = (sessionID) => {
        const db = openDb(dbPath)
        const row = db.query(`SELECT permission FROM session_v2 WHERE id = ?`).get(sessionID) as
          | { permission: string | null }
          | undefined
        db.close()
        if (!row?.permission) return []
        try {
          return JSON.parse(row.permission) as Rule[]
        } catch {
          return []
        }
      }
      const readDir = async (sessionID: string) => {
        const db = openDb(dbPath)
        const row = db.query(`SELECT directory FROM session_v2 WHERE id = ?`).get(sessionID) as
          | { directory: string }
          | undefined
        db.close()
        return resolvePath(row?.directory ?? "")
      }
      const headers = () => ({ Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` })
      const session = await (
        await fetch(`${url}/api/session`, {
          method: "POST",
          headers: { ...headers(), "Content-Type": "application/json" },
          body: "{}",
        })
      ).json()
      return {
        create: async () => {
          const res = await fetch(`${url}/api/session`, {
            method: "POST",
            headers: { ...headers(), "Content-Type": "application/json" },
            body: "{}",
          })
          const data = (await res.json()) as { data: { id: string } }
          return data.data.id
        },
        run: async (sessionID, name, args) => {
          const res = await fetch(`${url}/api/session/${sessionID}/command`, {
            method: "POST",
            headers: { ...headers(), "Content-Type": "application/json" },
            body: JSON.stringify({ name, text: args }),
          })
          const body = await res.text()
          log(`CMD ${name} -> ${res.status} ${body.slice(0, 200)}`)
        },
        apiDirectory: async (sessionID) => {
          const res = await fetch(`${url}/api/session/${sessionID}`, { headers: headers() })
          const data = (await res.json()) as { data: { location: { directory: string } } }
          return resolvePath(data.data.location.directory)
        },
        apiPermissions: async (sessionID) => {
          const res = await fetch(`${url}/api/session/${sessionID}`, { headers: headers() })
          const data = (await res.json()) as { data: { permissions?: unknown } }
          const raw = data.data.permissions
          if (!raw) return []
          if (typeof raw === "string") {
            try {
              return JSON.parse(raw) as Rule[]
            } catch {
              return []
            }
          }
          return raw as Rule[]
        },
        dbDirectory: readDir,
        dbPermissions: readCol,
        output,
        stop: () => kill(proc),
        ...({ seed: session } as object),
      } as Session
    },
  }
}

const V1_BIN = process.env.OPENCODE_V1_BIN || "opencode"
const V2_BIN = process.env.OPENCODE_V2_BIN || "opencode2"

const RUNTIME = (() => {
  const flag = process.argv.find((a) => a === "--v1" || a === "--v2") ?? process.env.BLACKBOX_RUNTIME
  if (flag === "v1" || flag === "--v1") return "v1"
  if (flag === "v2" || flag === "--v2") return "v2"
  throw new Error(
    "blackbox.test.ts requires an explicit runtime flag: run `npx vitest run blackbox.test.ts -- --v1` or `-- --v2` (or set BLACKBOX_RUNTIME=v1|v2)",
  )
})()

log(`runtime selected: ${RUNTIME}`)

function whichSync(cmd: string): string | null {
  const dirs = (process.env.PATH ?? "").split(":")
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, cmd)
    if (existsSync(p)) return p
  }
  return null
}

function pick(envVar: string, cmd: string): string {
  const explicit = process.env[envVar]
  if (explicit) return explicit
  const found = whichSync(cmd)
  if (!found) throw new Error(`${cmd} not found on PATH`)
  return found
}

function runContract(rt: Runtime): void {
  describe(`blackbox [${rt.id}]`, () => {
    let box: Sandbox
    let s: Session

    beforeAll(async () => {
      fakeProvider = new FakeProvider()
      await fakeProvider.start()
      log(`fake provider on port ${fakeProvider.port}`)
      box = makeSandbox(rt.id)
      log(`sandbox created: ${box.root}`)
      try {
        s = await rt.start(box)
        log(`server started: ${rt.binary} on ${box.root}`)
        await waitUntil(`${rt.id} plugin registers commands`, async () => {
          const id = await s.create()
          await s.run(id, "cd", box.repoA)
          await waitUntil(`${rt.id} first move lands`, async () => (await s.apiDirectory(id)) === resolvePath(box.repoA))
          return true
        })
      } catch (e) {
        if (s) await s.stop().catch(() => {})
        if (box) rmSync(box.root, { recursive: true, force: true })
        throw e
      }
    }, 180000)

    afterAll(async () => {
      if (s) await s.stop().catch(() => {})
      killAllSync()
      if (box) await new Promise((r) => setTimeout(r, 200))
      if (box) rmSync(box.root, { recursive: true, force: true })
      if (fakeProvider) await fakeProvider.close().catch(() => {})
      fakeProvider = undefined
    })

    it("pins the mock provider so no test reaches a real model", () => {
      expect(fakeProvider).toBeDefined()
      expect(fakeProvider!.port).toBeGreaterThan(0)
      expect(providerOverlayJson()).toContain(`127.0.0.1:${fakeProvider!.port}`)
    })

    it("registers every directory command", async () => {
      const id = await s.create()
      await s.run(id, "cd", box.repoB)
      await waitUntil("registered command works", async () => (await s.apiDirectory(id)) === resolvePath(box.repoB))
    })

    it("/cd moves the session and db agrees", async () => {
      const id = await s.create()
      expect(await s.apiDirectory(id)).toBe(resolvePath(box.project))
      await s.run(id, "cd", box.repoA)
      await waitUntil("cd applied", async () => (await s.apiDirectory(id)) === resolvePath(box.repoA))
      expect(await s.dbDirectory(id)).toBe(resolvePath(box.repoA))
    })

    it("/mv moves the session and db agrees", async () => {
      const id = await s.create()
      await s.run(id, "mv", box.repoB)
      await waitUntil("mv applied", async () => (await s.apiDirectory(id)) === resolvePath(box.repoB))
      expect(await s.dbDirectory(id)).toBe(resolvePath(box.repoB))
    })

    it("/cd resolves a relative target", async () => {
      const id = await s.create()
      const before = await s.apiDirectory(id)
      expect(before).toBe(resolvePath(box.project))
      await s.run(id, "cd", "../repoB")
      await waitUntil("relative cd applied", async () => (await s.apiDirectory(id)) === resolvePath(box.repoB))
    })

    it("/cd to a nonexistent directory leaves the session put", async () => {
      const id = await s.create()
      const before = await s.apiDirectory(id)
      await s.run(id, "cd", join(box.root, "nope-not-here"))
      await new Promise((r) => setTimeout(r, 1500))
      expect(await s.apiDirectory(id)).toBe(before)
    })

    it("/cd to a file leaves the session put", async () => {
      const id = await s.create()
      const before = await s.apiDirectory(id)
      await s.run(id, "cd", box.file)
      await new Promise((r) => setTimeout(r, 1500))
      expect(await s.apiDirectory(id)).toBe(before)
    })

    it("/add-dir grants external access", async () => {
      const id = await s.create()
      await s.run(id, "add-dir", box.extra)
      await waitUntil("grant visible", async () => covers(await s.apiPermissions(id), box.extra))
      expect(covers(await s.dbPermissions(id), box.extra)).toBe(true)
    })

    it("/add-dir twice keeps a single rule", async () => {
      const id = await s.create()
      await s.run(id, "add-dir", box.target)
      await waitUntil("grant visible", async () => covers(await s.apiPermissions(id), box.target))
      await s.run(id, "add-dir", box.target)
      await new Promise((r) => setTimeout(r, 1500))
      const rules = externalRules(await s.apiPermissions(id))
      expect(rules.filter((r) => covers([r], box.target))).toHaveLength(1)
    })

    it("/add-dir grants several distinct directories", async () => {
      const id = await s.create()
      await s.run(id, "add-dir", box.extra)
      await waitUntil("first grant", async () => covers(await s.apiPermissions(id), box.extra))
      await s.run(id, "add-dir", box.target)
      await waitUntil("second grant", async () => covers(await s.apiPermissions(id), box.target))
      expect(covers(await s.apiPermissions(id), box.extra)).toBe(true)
      expect(covers(await s.apiPermissions(id), box.target)).toBe(true)
    })

    it(
      "/remove-dir revokes external access",
      async () => {
        const id = await s.create()
        await s.run(id, "add-dir", box.extra)
        await waitUntil("grant visible", async () => covers(await s.apiPermissions(id), box.extra))
        await s.run(id, "remove-dir", box.extra)
        await waitUntil("grant gone", async () => !covers(await s.apiPermissions(id), box.extra))
        expect(covers(await s.dbPermissions(id), box.extra)).toBe(false)
      },
      60000,
    )

    it("/remove-dir on an ungranted directory changes nothing", async () => {
      const id = await s.create()
      await s.run(id, "add-dir", box.extra)
      await waitUntil("grant visible", async () => covers(await s.apiPermissions(id), box.extra))
      const before = externalRules(await s.apiPermissions(id)).length
      await s.run(id, "remove-dir", box.target)
      await new Promise((r) => setTimeout(r, 1500))
      const rules = externalRules(await s.apiPermissions(id))
      expect(rules).toHaveLength(before)
      expect(covers(rules, box.extra)).toBe(true)
    })

    it("holds a consistent state across mixed commands", async () => {
      const id = await s.create()
      await s.run(id, "cd", box.repoA)
      await waitUntil("cd", async () => (await s.apiDirectory(id)) === resolvePath(box.repoA))
      await s.run(id, "add-dir", box.extra)
      await waitUntil("add", async () => covers(await s.apiPermissions(id), box.extra))
      await s.run(id, "mv", box.repoB)
      await waitUntil("mv", async () => (await s.apiDirectory(id)) === resolvePath(box.repoB))
      expect(await s.apiDirectory(id)).toBe(resolvePath(box.repoB))
      expect(covers(await s.apiPermissions(id), box.extra)).toBe(true)
      expect(await s.dbDirectory(id)).toBe(resolvePath(box.repoB))
      expect(covers(await s.dbPermissions(id), box.extra)).toBe(true)
    })

    it("keeps the session readable after mutations", async () => {
      const id = await s.create()
      await s.run(id, "cd", box.repoA)
      await waitUntil("cd", async () => (await s.apiDirectory(id)) === resolvePath(box.repoA))
      await s.run(id, "add-dir", box.extra)
      await waitUntil("add", async () => covers(await s.apiPermissions(id), box.extra))
      expect(typeof (await s.apiDirectory(id))).toBe("string")
      expect(await s.dbDirectory(id)).toBe(resolvePath(box.repoA))
    })
  })
}

describe("runtime discovery", () => {
  it(`resolves the ${RUNTIME} binary`, () => {
    const bin = RUNTIME === "v1" ? pick("OPENCODE_V1_BIN", V1_BIN) : pick("OPENCODE_V2_BIN", V2_BIN)
    log(`[discovery] ${RUNTIME} -> ${bin}`)
    expect(bin).toBeTruthy()
  })
})

if (RUNTIME === "v1") runContract(v1Runtime(pick("OPENCODE_V1_BIN", V1_BIN)))
else runContract(v2Runtime(pick("OPENCODE_V2_BIN", V2_BIN)))
