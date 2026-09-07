import { createRequire } from "node:module"

export interface SQLiteStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number }
}

export interface SQLiteDatabase {
  exec(sql: string): void
  prepare(sql: string): SQLiteStatement
  close(): void
}

const require = createRequire(import.meta.url)
let DatabaseImpl: { new (path: string): SQLiteDatabase } | null = null
let isNodeSqlite = false
try {
  const mod = require("node:sqlite")
  if (mod.DatabaseSync) {
    DatabaseImpl = mod.DatabaseSync as { new (path: string): SQLiteDatabase }
    isNodeSqlite = true
  } else throw new Error("no DatabaseSync")
} catch {
  try {
    const mod = require("bun:sqlite")
    DatabaseImpl = mod.Database as { new (path: string): SQLiteDatabase }
    isNodeSqlite = false
  } catch (e) {
    throw new Error("No sqlite implementation found (node:sqlite or bun:sqlite)")
  }
}

export class Database {
  private db: SQLiteDatabase
  constructor(path: string) {
    this.db = new (DatabaseImpl as { new (path: string): SQLiteDatabase })(path)
    try { this.db.exec("PRAGMA foreign_keys = OFF") } catch {}
    try { this.db.exec("PRAGMA journal_mode = WAL") } catch {}
    try { this.db.exec("PRAGMA busy_timeout = 5000") } catch {}
    try { this.db.exec("PRAGMA synchronous = NORMAL") } catch {}
  }
  exec(sql: string) {
    this.db.exec(sql)
  }
  prepare(sql: string): SQLiteStatement {
    return this.db.prepare(sql)
  }
  query(sql: string) {
    return this.prepare(sql)
  }
  run(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).run(...params)
  }
  transaction(fn: () => void) {
    return () => {
      this.db.exec("BEGIN IMMEDIATE")
      try {
        fn()
        this.db.exec("COMMIT")
      } catch (e) {
        try { this.db.exec("ROLLBACK") } catch {}
        throw e
      }
    }
  }
  transactionImmediate(fn: () => void) {
    return this.transaction(fn)
  }
  close() {
    this.db.close()
  }
}
