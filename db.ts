import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
let DatabaseImpl: any = null
let isNodeSqlite = false
try {
  // Node 22.5+ has node:sqlite
  const mod = require("node:sqlite")
  if (mod.DatabaseSync) {
    DatabaseImpl = mod.DatabaseSync
    isNodeSqlite = true
  } else throw new Error("no DatabaseSync")
} catch {
  // Bun fallback
  try {
    const mod = require("bun:sqlite")
    DatabaseImpl = mod.Database
    isNodeSqlite = false
  } catch (e) {
    throw new Error("No sqlite implementation found (node:sqlite or bun:sqlite)")
  }
}

export class Database {
  private db: any
  constructor(path: string) {
    this.db = new DatabaseImpl(path)
    try { this.db.exec("PRAGMA foreign_keys = OFF") } catch {}
  }
  exec(sql: string) {
    this.db.exec(sql)
  }
  prepare(sql: string) {
    const stmt = this.db.prepare(sql)
    return {
      get: (...params: unknown[]) => (stmt as any).get(...params),
      all: (...params: unknown[]) => (stmt as any).all(...params),
      run: (...params: unknown[]) => (stmt as any).run(...params),
    }
  }
  query(sql: string) {
    return this.prepare(sql)
  }
  run(sql: string, params: unknown[] = []) {
    const stmt = this.db.prepare(sql)
    return (stmt as any).run(...params)
  }
  transaction(fn: () => void) {
    return () => {
      this.db.exec("BEGIN")
      try {
        fn()
        this.db.exec("COMMIT")
      } catch (e) {
        try { this.db.exec("ROLLBACK") } catch {}
        throw e
      }
    }
  }
  close() {
    this.db.close()
  }
}
