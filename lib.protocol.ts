import { Database } from "./db"
import { reportError } from "./lib"

export type DriftReport = { ok: boolean; missing: string[] }

export interface CommandProtocol {
  name: string
  required: { table: string; columns: string[] }[]
  driftCheck(db: Database): DriftReport
  execute(db: Database, args: any): any
}

function check(db: Database, required: { table: string; columns: string[] }[]): DriftReport {
  const missing: string[] = []
  for (const { table, columns } of required) {
    const row = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) as any
    if (!row) { missing.push(`table:${table}`); continue }
    const cols = db.query(`PRAGMA table_info(${table})`).all() as any[]
    const names = new Set(cols.map((c) => c.name))
    for (const col of columns) if (!names.has(col)) missing.push(`${table}.${col}`)
  }
  return { ok: missing.length === 0, missing }
}

export const CdProtocol: CommandProtocol = {
  name: "cd",
  required: [
    { table: "session", columns: ["id", "directory", "project_id", "permission", "time_updated"] },
    { table: "project", columns: ["id", "worktree"] },
    { table: "message", columns: ["id", "session_id", "data"] },
  ],
  driftCheck(db) { return check(db, this.required) },
  execute(db, args) { return null }
}

export const AddDirProtocol: CommandProtocol = {
  name: "add-dir",
  required: [
    { table: "session", columns: ["id", "permission"] },
    { table: "permission", columns: ["id", "project_id", "action", "resource"] },
  ],
  driftCheck(db) { return check(db, this.required) },
  execute(db, args) { return null }
}

export const registry: Record<string, CommandProtocol> = {
  cd: CdProtocol,
  mv: CdProtocol,
  "add-dir": AddDirProtocol,
  "remove-dir": AddDirProtocol,
  vault: AddDirProtocol,
}

export async function runWithDriftCheck(db: Database, proto: CommandProtocol, toast: (msg: string)=>Promise<void>, fn: ()=>any) {
  const report = proto.driftCheck(db)
  if (!report.ok) {
    await reportError(new Error(`drift ${proto.name}: missing ${report.missing.join(",")}`))
    await toast("Heads up — syncing with new opencode version, things will be alright soon.")
  }
  return fn()
}
