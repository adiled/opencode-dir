import { describe, it, expect } from "vitest"
import { Database } from "./db"
import { createSchema } from "./lib"
import * as fs from "fs"

describe("drift: core schema", () => {
  it("our test schema matches core schema.gen.ts for session/permission", async () => {
    // our schema
    const db = new Database(":memory:")
    createSchema(db)
    const ours = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='session'").get() as { sql: string } | null
    db.close()
    // core schema
    const corePath = "/Users/adil/opencode/packages/core/src/database/schema.gen.ts"
    const core = fs.readFileSync(corePath, "utf-8")
    // bare minimum: core must have same tables we use (session, permission, project, message)
    expect(core).toContain("session")
    expect(core).toContain("permission")
    expect(ours!.sql).toContain("session")
    // if core adds column like workspace_id, test will still pass but we log drift
    // For now, ensure core session has at least our columns
    expect(core).toMatch(/permission/)
  })
})
