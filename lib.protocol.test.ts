import { describe, it, expect } from "vitest"
import { Database } from "./db"
import { createSchema } from "./lib"
import { CdProtocol, AddDirProtocol } from "./lib.protocol"

function dbWithSchema(): Database {
  const db = new Database(":memory:")
  createSchema(db)
  db.exec(`CREATE TABLE IF NOT EXISTS permission (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`)
  return db
}

describe("protocol driftCheck", () => {
  it("cd ok on good schema", () => {
    const db = dbWithSchema()
    expect(CdProtocol.driftCheck(db).ok).toBe(true)
    db.close()
  })
  it("add-dir ok", () => {
    const db = dbWithSchema()
    expect(AddDirProtocol.driftCheck(db).ok).toBe(true)
    db.close()
  })
  it("detects missing permission table", () => {
    const db = new Database(":memory:")
    createSchema(db)
    // no permission table
    const r = AddDirProtocol.driftCheck(db)
    expect(r.ok).toBe(false)
    expect(r.missing.join(",")).toContain("permission")
    db.close()
  })
})
