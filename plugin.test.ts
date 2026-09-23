import { describe, it, expect, afterEach } from "vitest"
import { OpencodeDir } from "./index"
import { Database } from "./db"
import { createSchema } from "./lib"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

describe("plugin config", () => {
  it("registers all 5 slash commands", async () => {
    const fakeClient = {
      tui: { showToast: () => ({ catch: () => {} }) },
    }
    // Mock fs-dependent parts: initPluginGuard and state dir
    const plugin = await OpencodeDir({ client: fakeClient } as unknown as Parameters<typeof OpencodeDir>[0])
    const input = { command: {} as Record<string, { template: string; description: string }> }
    await plugin.config!(input)
    expect(Object.keys(input.command).sort()).toEqual(["add-dir", "cd", "mv", "remove-dir", "vault"].sort())
    expect(input.command["remove-dir"].description).toMatch(/Revoke/)
  })

  it("db wrapper works in node (and bun fallback)", async () => {
    const { Database } = await import("./db")
    const db = new Database(":memory:")
    db.exec("CREATE TABLE t (id TEXT)")
    const res = db.run("INSERT INTO t (id) VALUES (?)", ["a"])
    expect(res.changes).toBe(1)
    expect((db.query("SELECT * FROM t").all() as unknown[]).length).toBe(1)
    db.close()
  })
})

describe("plugin command.execute.before", () => {
  let tmp: string
  const fakeClient = {
    app: { log: () => Promise.resolve() },
    tui: { showToast: () => ({ catch: () => {} }) },
    session: { abort: () => Promise.resolve() },
  }

  function makeSessionInput(command: string, args: string, sessionID = "ses_1") {
    return {
      plugin: null as Awaited<ReturnType<typeof OpencodeDir>> | null,
      input: { command, sessionID, arguments: args },
      output: { parts: [] as unknown[] },
      async load() {
        this.plugin = await OpencodeDir({ client: fakeClient } as unknown as Parameters<typeof OpencodeDir>[0])
      },
      async run() {
        if (!this.plugin) await this.load()
        await this.plugin!["command.execute.before"]!(
          this.input as never,
          this.output as never,
        )
        return this.output.parts
      },
    }
  }

  afterEach(() => {
    delete process.env.OPENCODE_DB
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it("suppresses the chat message (parts=[]) when /cd targets a file", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ocd-plugin-"))
    process.env.OPENCODE_DB = join(tmp, "opencode.db")
    const db = new Database(process.env.OPENCODE_DB)
    try {
      createSchema(db)
      db.run(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["ses_1", "proj_1", "slug", tmp, "t", "1", Date.now(), Date.now()],
      )
    } finally {
      db.close()
    }

    const run = makeSessionInput("cd", "/etc/hosts")
    const parts = await run.run()
    expect(parts).toEqual([])
  })

  it("suppresses the chat message (parts=[]) when /cd has no target", async () => {
    const run = makeSessionInput("cd", "")
    const parts = await run.run()
    expect(parts).toEqual([])
  })
})