import { DatabaseSync } from "node:sqlite"

export class Database {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
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
