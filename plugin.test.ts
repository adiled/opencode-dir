import { describe, it, expect } from "vitest"
import { OpencodeDir } from "./index"

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
