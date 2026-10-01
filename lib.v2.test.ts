import { describe, it, expect, beforeEach } from "vitest"
import {
  appendExternalDirectory,
  removeExternalDirectory,
  externalDirectoryResource,
  extractTargetArgument,
  serializeV2Log,
  buildV2Commands,
  runV2Command,
  setupV2,
  TOAST_RPC,
  type V2Context,
  type V2Rule,
  type V2Deps,
} from "./lib.v2"

function mockCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Record<string, unknown[]> = { move: [], update: [], synthetic: [], dispose: [] }
  let info: { id: string; location: { directory: string }; permissions?: V2Rule[] } = {
    id: "ses_1",
    location: { directory: "/from" },
    permissions: [],
  }
  const ctx = {
    options: {},
    app: { name: "opencode", version: "2.0.20", channel: "latest" },
    command: {
      transform: async (cb: (e: { add: (d: unknown) => void }) => void) => {
        const added: unknown[] = []
        cb({ add: (d) => added.push(d) })
        return { dispose: async () => void calls.dispose.push("command") }
      },
    },
    session: {
      get: async () => info,
      move: async (input: unknown) => void calls.move.push(input),
      update: async (input: unknown) => void calls.update.push(input),
      synthetic: async (input: unknown) => void calls.synthetic.push(input),
    },
    tool: { hook: async () => ({ dispose: async () => void calls.dispose.push("tool") }) },
    shell: { hook: async () => ({ dispose: async () => void calls.dispose.push("shell") }) },
    storage: { get: async () => undefined, set: async () => {} },
    calls,
    setInfo: (next: typeof info) => {
      info = next
    },
    registered: [] as unknown[],
  } as unknown as V2Context & {
    calls: typeof calls
    setInfo: (n: typeof info) => void
    registered: unknown[]
  }
  const originalTransform = ctx.command.transform.bind(ctx.command)
  ctx.command.transform = (async (cb: (e: { add: (d: unknown) => void }) => void) => {
    ctx.registered.push(
      ...(() => {
        const out: unknown[] = []
        cb({ add: (d) => out.push(d) })
        return out
      })(),
    )
    return originalTransform(() => {})
  }) as typeof ctx.command.transform
  return Object.assign(ctx, overrides)
}

type FakeRow = {
  id: string
  directory: string
  project_id?: string
  path?: string | null
  permission?: string | null
  [key: string]: unknown
}

function fakeDb(rows: Record<string, FakeRow> = {}) {
  const sessions = new Map<string, FakeRow>(Object.entries(rows))
  const messages: { id: string; session_id: string; data: string }[] = []
  const projects = new Map<string, { id: string; worktree: string }>()
  const permissions: string[] = []
  const db = {
    sessions,
    messages,
    projects,
    permissions,
    query(sql: string) {
      if (sql.includes("FROM project WHERE worktree")) {
        return {
          get: (...args: unknown[]) => {
            for (const p of projects.values()) if (p.worktree === args[0]) return p
            return undefined
          },
        }
      }
      if (sql.includes("FROM session_v2 WHERE id")) {
        return { get: (id: unknown) => sessions.get(id as string) }
      }
      if (sql.includes("FROM session_message WHERE session_id")) {
        return { all: (sid: unknown) => messages.filter((m) => m.session_id === sid) }
      }
      if (sql.includes("SELECT id FROM permission")) {
        return { get: () => undefined }
      }
      return { all: () => [], get: () => undefined }
    },
    run(sql: string, args: unknown[] = []) {
      if (sql.startsWith("UPDATE session_v2")) {
        const row = sessions.get(args[5] as string)
        if (!row) return { changes: 0 }
        Object.assign(row, {
          directory: args[0],
          project_id: args[1],
          path: args[2],
          permission: args[3],
          time_updated: args[4],
        })
        return { changes: 1 }
      }
      if (sql.startsWith("INSERT INTO project")) {
        const id = args[0] as string
        projects.set(id, { id, worktree: args[1] })
        return { changes: 1 }
      }
      if (sql.startsWith("UPDATE session_message")) {
        const msg = messages.find((m) => m.id === args[1])
        if (msg) msg.data = args[0] as string
        return { changes: 1 }
      }
      return { changes: 1 }
    },
    transaction<T>(cb: () => T) {
      return () => cb()
    },
    close() {},
  }
  return db
}

function deps(overrides: Record<string, unknown> = {}, dbRows: Record<string, FakeRow> = {}): V2Deps & {
  persisted: () => number
  db: ReturnType<typeof fakeDb>
  sessions: Map<string, FakeRow>
} {
  const store = new Map<string, string>()
  let persisted = 0
  const db = fakeDb(dbRows)
  return {
    overrides: store,
    persisted: () => persisted,
    db,
    sessions: db.sessions,
    resolveDir: (raw: string) => ({ dir: raw.startsWith("/") ? raw : `/resolved/${raw}` }),
    persistOverrides: () => {
      persisted++
    },
    openDb: () => db,
    ...overrides,
  }
}

describe("v2 permissions", () => {
  it("builds a forward-slash external_directory resource", () => {
    expect(externalDirectoryResource("/tmp/extra")).toBe("/tmp/extra/*")
    expect(externalDirectoryResource("/tmp/extra/")).toBe("/tmp/extra/*")
    expect(externalDirectoryResource("C:\\tmp\\extra")).toBe("C:/tmp/extra/*")
  })

  it("appends an allow rule", () => {
    const out = appendExternalDirectory([], "/tmp/extra")
    expect(out.added).toBe(true)
    expect(out.rules).toEqual([{ action: "external_directory", resource: "/tmp/extra/*", effect: "allow" }])
  })

  it("preserves existing rules and order", () => {
    const existing: V2Rule[] = [
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "question", resource: "*", effect: "deny" },
    ]
    const out = appendExternalDirectory(existing, "/tmp/extra")
    expect(out.rules.slice(0, 2)).toEqual(existing)
    expect(out.rules).toHaveLength(3)
  })

  it("is idempotent", () => {
    const first = appendExternalDirectory([], "/tmp/extra")
    const second = appendExternalDirectory(first.rules, "/tmp/extra")
    expect(second.added).toBe(false)
    expect(second.rules).toHaveLength(1)
  })

  it("removes only the matching resource", () => {
    const rules: V2Rule[] = [
      { action: "external_directory", resource: "/tmp/a/*", effect: "allow" },
      { action: "external_directory", resource: "/tmp/b/*", effect: "allow" },
      { action: "read", resource: "*", effect: "allow" },
    ]
    const out = removeExternalDirectory(rules, "/tmp/a")
    expect(out.removed).toBe(true)
    expect(out.rules).toEqual([
      { action: "external_directory", resource: "/tmp/b/*", effect: "allow" },
      { action: "read", resource: "*", effect: "allow" },
    ])
  })

  it("reports no-op removal", () => {
    const out = removeExternalDirectory([], "/tmp/a")
    expect(out.removed).toBe(false)
  })
})

describe("v2 argument parsing", () => {
  it("strips quotes and whitespace", () => {
    expect(extractTargetArgument('  "/tmp/a b"  ')).toBe("/tmp/a b")
    expect(extractTargetArgument("'/tmp/x'")).toBe("/tmp/x")
    expect(extractTargetArgument("")).toBe("")
  })
})

describe("v2 logging", () => {
  it("emits structured json with a timestamp and surface marker", () => {
    const parsed = JSON.parse(serializeV2Log({ event: "test", command: "cd" }))
    expect(parsed.service).toBe("opencode-dir")
    expect(parsed.surface).toBe("v2")
    expect(parsed.event).toBe("test")
    expect(parsed.command).toBe("cd")
    expect(typeof parsed.ts).toBe("string")
  })
})

describe("v2 command registration", () => {
  it("registers four definitions carrying name and execute, never template", () => {
    const ctx = mockCtx()
    const d = deps()
    const commands = buildV2Commands(d, ctx)
    expect(commands.map((c) => c.name)).toEqual(["cd", "mv", "add-dir", "remove-dir"])
    for (const c of commands) {
      expect(typeof c.name).toBe("string")
      expect(c.name.length).toBeGreaterThan(0)
      expect(typeof c.execute).toBe("function")
      expect(c).not.toHaveProperty("template")
    }
  })

  it("gives every definition a description", () => {
    const commands = buildV2Commands(deps(), mockCtx())
    for (const c of commands) expect(typeof c.description).toBe("string")
  })
})

describe("v2 command execution", () => {
  let ctx: ReturnType<typeof mockCtx>
  let d: ReturnType<typeof deps>

  beforeEach(() => {
    ctx = mockCtx()
    d = deps({}, { ses_1: { id: "ses_1", directory: "/from", project_id: "prj_a", path: null, permission: null } })
  })

  const invoke = (command: string, text: string) => ({ sessionID: "ses_1", prompt: { text }, delivery: "steer" as const })

  it("cd writes the new directory straight to the database", async () => {
    const out = await runV2Command(d, ctx, "cd", invoke("cd", "/target"))
    expect(out.status).toBe("ok")
    expect(d.sessions.get("ses_1").directory).toBe("/target")
    expect(ctx.calls.move).toHaveLength(0)
    expect(ctx.calls.update).toHaveLength(0)
  })

  it("cd grants the new directory an external_directory rule", async () => {
    await runV2Command(d, ctx, "cd", invoke("cd", "/target"))
    const perms = JSON.parse(d.sessions.get("ses_1").permission)
    expect(perms).toEqual([{ action: "external_directory", resource: "/target/*", effect: "allow" }])
  })

  it("cd records an override for tool and shell injection", async () => {
    await runV2Command(d, ctx, "cd", invoke("cd", "/target"))
    expect(d.overrides.get("ses_1")).toBe("/target")
    expect(d.persisted()).toBe(1)
  })

  it("mv moves the directory like cd", async () => {
    const out = await runV2Command(d, ctx, "mv", invoke("mv", "/target"))
    expect(out.status).toBe("ok")
    expect(d.sessions.get("ses_1").directory).toBe("/target")
  })

  it("cd leaves message history untouched", async () => {
    d.db.messages.push({ id: "m1", session_id: "ses_1", data: JSON.stringify({ role: "assistant", path: { cwd: "/from", root: "/from" } }) })
    await runV2Command(d, ctx, "cd", invoke("cd", "/target"))
    expect(JSON.parse(d.db.messages[0].data).path.cwd).toBe("/from")
  })

  it("mv rewrites path.cwd and path.root in message history", async () => {
    d.db.messages.push({ id: "m1", session_id: "ses_1", data: JSON.stringify({ role: "assistant", path: { cwd: "/from", root: "/from" } }) })
    const out = await runV2Command(d, ctx, "mv", invoke("mv", "/target"))
    expect(out.status).toBe("ok")
    const data = JSON.parse(d.db.messages[0].data)
    expect(data.path.cwd).toBe("/target")
    expect(data.path.root).toBe("/target")
    expect(out.result).toContain("1/1 rewritten")
  })

  it("mv skips an in-flight turn", async () => {
    d.db.messages.push({
      id: "m1",
      session_id: "ses_1",
      data: JSON.stringify({ role: "assistant", time: { created: 1 }, path: { cwd: "/from", root: "/from" } }),
    })
    const out = await runV2Command(d, ctx, "mv", invoke("mv", "/target"))
    expect(JSON.parse(d.db.messages[0].data).path.cwd).toBe("/from")
    expect(out.result).toContain("1 skipped")
  })

  it("no-ops the override when the directory is unchanged", async () => {
    const out = await runV2Command(d, ctx, "cd", invoke("cd", "/from"))
    expect(out.status).toBe("info")
    expect(d.overrides.has("ses_1")).toBe(false)
    expect(d.persisted()).toBe(0)
  })

  it("errors on a missing target without calling the host", async () => {
    const out = await runV2Command(d, ctx, "cd", invoke("cd", ""))
    expect(out.status).toBe("error")
    expect(out.result).toContain("Usage: /cd <path>")
    expect(ctx.calls.move).toHaveLength(0)
  })

  it("surfaces a resolver failure as a user error", async () => {
    const failing = {
      ...deps(),
      resolveDir: () => {
        throw new Error("Directory does not exist: /nope")
      },
    }
    const out = await runV2Command(failing, ctx, "cd", invoke("cd", "/nope"))
    expect(out.status).toBe("error")
    expect(out.result).toContain("Directory does not exist")
    expect(ctx.calls.move).toHaveLength(0)
  })

  it("add-dir appends a permission rule via session.update", async () => {
    ctx.setInfo({ id: "ses_1", location: { directory: "/from" }, permissions: [] })
    const out = await runV2Command(d, ctx, "add-dir", invoke("add-dir", "/extra"))
    expect(out.status).toBe("ok")
    expect(ctx.calls.update).toEqual([
      { sessionID: "ses_1", permissions: [{ action: "external_directory", resource: "/extra/*", effect: "allow" }] },
    ])
  })

  it("add-dir preserves pre-existing rules", async () => {
    ctx.setInfo({
      id: "ses_1",
      location: { directory: "/from" },
      permissions: [{ action: "read", resource: "*.env", effect: "ask" }],
    })
    await runV2Command(d, ctx, "add-dir", invoke("add-dir", "/extra"))
    const written = ctx.calls.update[0] as { permissions: V2Rule[] }
    expect(written.permissions).toHaveLength(2)
    expect(written.permissions[0]).toEqual({ action: "read", resource: "*.env", effect: "ask" })
  })

  it("add-dir is idempotent", async () => {
    ctx.setInfo({
      id: "ses_1",
      location: { directory: "/from" },
      permissions: [{ action: "external_directory", resource: "/extra/*", effect: "allow" }],
    })
    const out = await runV2Command(d, ctx, "add-dir", invoke("add-dir", "/extra"))
    expect(out.status).toBe("info")
    expect(ctx.calls.update).toHaveLength(0)
  })

  it("remove-dir drops the matching rule", async () => {
    ctx.setInfo({
      id: "ses_1",
      location: { directory: "/from" },
      permissions: [
        { action: "external_directory", resource: "/extra/*", effect: "allow" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    })
    const out = await runV2Command(d, ctx, "remove-dir", invoke("remove-dir", "/extra"))
    expect(out.status).toBe("ok")
    const written = ctx.calls.update[0] as { permissions: V2Rule[] }
    expect(written.permissions).toEqual([{ action: "read", resource: "*", effect: "allow" }])
  })

  it("remove-dir reports a no-op", async () => {
    ctx.setInfo({ id: "ses_1", location: { directory: "/from" }, permissions: [] })
    const out = await runV2Command(d, ctx, "remove-dir", invoke("remove-dir", "/extra"))
    expect(out.status).toBe("info")
    expect(ctx.calls.update).toHaveLength(0)
  })

  it("reports a missing session row", async () => {
    const empty = deps({}, {})
    const out = await runV2Command(empty, mockCtx(), "cd", invoke("cd", "/other"))
    expect(out.status).toBe("error")
    expect(out.result).toContain("not found in database")
  })

  it("reports a database failure", async () => {
    const broken = deps({
      openDb: () => {
        throw new Error("database is locked")
      },
    })
    const out = await runV2Command(broken, mockCtx(), "cd", invoke("cd", "/other"))
    expect(out.status).toBe("error")
    expect(out.result).toContain("database operation failed")
  })

  it("reports a host update failure", async () => {
    const broken = mockCtx()
    broken.session.update = async () => {
      throw new Error("nope")
    }
    const out = await runV2Command(d, broken, "add-dir", invoke("add-dir", "/extra"))
    expect(out.status).toBe("error")
    expect(out.result).toContain("nope")
  })
})

describe("v2 setup", () => {
  it("registers, hooks, and disposes cleanly", async () => {
    const ctx = mockCtx()
    const d = deps()
    const handle = await setupV2(ctx, d)
    expect(ctx.registered).toHaveLength(4)
    await handle.dispose()
    expect([...ctx.calls.dispose].sort((a, b) => a.localeCompare(b))).toEqual(["command", "shell", "tool"])
  })

  it("surfaces the outcome to the user as a synthetic message", async () => {
    const ctx = mockCtx()
    const d = deps({}, { ses_1: { id: "ses_1", directory: "/from", project_id: "prj_a", path: null, permission: null } })
    const commands = buildV2Commands(d, ctx)
    const cd = commands[0]!
    await cd.execute({ sessionID: "ses_1", prompt: { text: "/target" }, delivery: "steer" })
    expect(ctx.calls.synthetic).toHaveLength(1)
    const msg = ctx.calls.synthetic[0] as { text: string; description: string }
    expect(msg.text).toContain("/target")
    expect(msg.description).toBe("ok")
  })

  it("surfaces errors as synthetic messages rather than throwing", async () => {
    const ctx = mockCtx()
    const commands = buildV2Commands(deps(), ctx)
    await commands[0]!.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })
    const msg = ctx.calls.synthetic[0] as { description: string }
    expect(msg.description).toBe("error")
  })

  it("emits a toast event for a successful command", async () => {
    const ctx = mockCtx()
    const toasts: Array<Record<string, unknown>> = []
    const d = deps({}, { ses_1: { id: "ses_1", directory: "/from", project_id: "prj_a", path: null, permission: null } })
    d.toast = (input) => toasts.push(input as Record<string, unknown>)
    const commands = buildV2Commands(d, ctx)
    await commands[0]!.execute({ sessionID: "ses_1", prompt: { text: "/target" }, delivery: "steer" })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.variant).toBe("success")
    expect(String(toasts[0]!.message)).toContain("/target")
  })

  it("emits an error toast for a usage failure", async () => {
    const ctx = mockCtx()
    const toasts: Array<Record<string, unknown>> = []
    const d = deps()
    d.toast = (input) => toasts.push(input as Record<string, unknown>)
    const commands = buildV2Commands(d, ctx)
    await commands[0]!.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.variant).toBe("error")
  })

  it("keeps running when the toast emitter throws", async () => {
    const ctx = mockCtx()
    const d = deps({}, { ses_1: { id: "ses_1", directory: "/from", project_id: "prj_a", path: null, permission: null } })
    d.toast = () => {
      throw new Error("bus gone")
    }
    const commands = buildV2Commands(d, ctx)
    await expect(
      commands[0]!.execute({ sessionID: "ses_1", prompt: { text: "/target" }, delivery: "steer" }),
    ).resolves.toBeUndefined()
    expect(ctx.calls.synthetic).toHaveLength(1)
  })

  it("omits the toast key when no emitter is wired", () => {
    expect("toast" in deps()).toBe(false)
  })

  it("declares the toast RPC event under the opencode-dir id", () => {
    expect(TOAST_RPC.id).toBe("opencode-dir")
    expect(Object.keys(TOAST_RPC.events)).toEqual(["toast"])
    const schema = (TOAST_RPC.events as { toast: { schema: { required: string[] } } }).toast.schema
    expect(schema.required).toEqual(["message"])
  })
})
