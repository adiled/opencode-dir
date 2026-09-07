import { Database } from "./db"
import { resolve, join, isAbsolute } from "path"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { execSync } from "child_process"
import { homedir } from "os"

// Guard: only allow execMove / execAddDir when called from within opencode's plugin system.
let _pluginInitialized = false
/** Marks this module as being used by opencode's plugin loader. */
export function initPluginGuard() { _pluginInitialized = true }
function checkGuard() {
  if (!_pluginInitialized && typeof process !== "undefined" && !process.env.OPENCODE_DIR_TEST) {
    throw new Error(
      "opencode-dir functions must be called from within the opencode plugin system. " +
      "Direct imports from test harnesses or standalone scripts are not supported.",
    )
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error telemetry (zero-dep Sentry envelope API)
// ---------------------------------------------------------------------------

const SENTRY_DSN = "https://3dc34b92b6635091e8f0feba7bf6f9c5@o4510982366625792.ingest.us.sentry.io/4510982373769216"

let _version: string | undefined

export function getVersion(): string {
  if (!_version) {
    try {
      const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))
      _version = pkg.version
    } catch {
      _version = "unknown"
    }
  }
  return _version!
}

/** Reports an error to Sentry. Silent on failure - must never break the plugin. */
// Context-rich error report for update checks
export async function reportUpdateError(context: { message: string; error: Error; currentVersion: string; url: string }) {
  if (process.env.OPENCODE_DIR_TEST || process.env.VITEST) return
  try {
    const { platform, arch, release } = await import("os")
    const url = new URL(SENTRY_DSN)
    const projectId = url.pathname.slice(1)
    const publicKey = url.username
    const endpoint = `https://${url.host}/api/${projectId}/envelope/`

    const header = JSON.stringify({
      event_id: crypto.randomUUID().replace(/-/g, ""),
      dsn: SENTRY_DSN,
      sent_at: new Date().toISOString(),
    })
    const item = JSON.stringify({ type: "event" })
    const payload = JSON.stringify({
      exception: {
        values: [{
          type: context.error.name,
          value: context.error.message,
          stacktrace: {
            frames: (context.error.stack ?? "").split("\n").slice(1).map((line) => ({
              filename: line.trim(),
            })),
          },
        }],
      },
      release: `opencode-dir@${context.currentVersion}`,
      platform: "node",
      environment: "production",
      contexts: {
        os: { name: platform(), version: release() },
        device: { arch: arch() },
        runtime: { name: "node", version: process.version },
        app: { app_version: context.currentVersion, opencode_version: getOpencodeVersion() ?? "unknown" },
        client: { client: process.env.OPENCODE_CLIENT ?? "cli", caller: process.env.OPENCODE_CALLER ?? "unknown" },
      },
      tags: {
        check_type: "update",
        url: context.url,
        os: platform(),
        arch: arch(),
        node: process.version,
        client: process.env.OPENCODE_CLIENT ?? "cli",
        caller: process.env.OPENCODE_CALLER ?? "unknown",
      },
      extra: {
        cwd: process.cwd(),
        channel: process.env.OPENCODE_CHANNEL ?? "latest",
        open_client: process.env.OPENCODE_CLIENT ?? "cli",
        open_caller: process.env.OPENCODE_CALLER ?? "unknown",
      },
    })

    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_key=${publicKey}, sentry_version=7`,
      },
      body: `${header}\n${item}\n${payload}`,
    })
  } catch {
    // Silent - telemetry must never break the plugin
  }
}

export async function reportError(err: Error) {
  if (process.env.OPENCODE_DIR_TEST || process.env.VITEST) return
  try {
    const os = await import("os")
    const url = new URL(SENTRY_DSN)
    const projectId = url.pathname.slice(1)
    const publicKey = url.username
    const endpoint = `https://${url.host}/api/${projectId}/envelope/`

    const header = JSON.stringify({
      event_id: crypto.randomUUID().replace(/-/g, ""),
      dsn: SENTRY_DSN,
      sent_at: new Date().toISOString(),
    })
    const item = JSON.stringify({ type: "event" })
    const payload = JSON.stringify({
      exception: {
        values: [{
          type: err.name,
          value: err.message,
          stacktrace: {
            frames: (err.stack ?? "").split("\n").slice(1).map((line) => ({
              filename: line.trim(),
            })),
          },
        }],
      },
      release: `opencode-dir@${getVersion()}`,
      platform: "node",
      environment: "production",
      contexts: {
        os: { name: os.platform(), version: os.release() },
        device: { arch: os.arch() },
        runtime: { name: "node", version: process.version },
        app: { app_version: getVersion(), opencode_version: getOpencodeVersion() ?? "unknown" },
        client: { client: process.env.OPENCODE_CLIENT ?? "cli", caller: process.env.OPENCODE_CALLER ?? "unknown" },
      },
      tags: {
        os: os.platform(),
        arch: os.arch(),
        node: process.version,
        opencode: getOpencodeVersion() ?? "unknown",
        client: process.env.OPENCODE_CLIENT ?? "cli",
        caller: process.env.OPENCODE_CALLER ?? "unknown",
      },
      extra: {
        cwd: process.cwd(),
        argv: process.argv.slice(0, 5).join(" "),
        channel: process.env.OPENCODE_CHANNEL ?? "latest",
        open_client: process.env.OPENCODE_CLIENT ?? "cli",
        open_caller: process.env.OPENCODE_CALLER ?? "unknown",
      },
    })

    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_key=${publicKey}, sentry_version=7`,
      },
      body: `${header}\n${item}\n${payload}`,
    })
  } catch {
    // Silent - telemetry must never break the plugin
  }
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export interface Override {
  oldDir: string
  newDir: string
}

/** Loads session directory overrides from a JSON file on disk. */
export function loadOverrides(path: string): Map<string, Override> {
  try {
    const entries = JSON.parse(readFileSync(path, "utf-8")) as [string, Override][]
    return new Map(entries)
  } catch {
    return new Map()
  }
}

/** Persists session directory overrides to disk (owner-only). */
export function persistOverrides(path: string, map: Map<string, Override>) {
  writeFileSync(path, JSON.stringify([...map.entries()]), { mode: 0o600 })
}


// ---------------------------------------------------------------------------
// Version check
// ---------------------------------------------------------------------------

export const MIN_OPENCODE_VERSION = "1.4.3"

declare const OPENCODE_VERSION: string | undefined

/**
 * Reads the opencode version from the `OPENCODE_VERSION` global
 * (injected at build time by opencode).
 * Returns `null` when the global is absent (e.g. very old builds).
 */
export function getOpencodeVersion(): string | null {
  try {
    // eslint-disable-next-line no-undef
    return typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : null
  } catch {
    return null
  }
}

/**
 * Compares two semver strings (major.minor.patch only).
 * Returns true if `version` >= `minimum`.
 * Returns true for non-semver values (e.g. "local") to avoid
 * false positives on dev builds.
 */
export function meetsMinVersion(version: string, minimum: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
    return m ? [+m[1], +m[2], +m[3]] : null
  }
  const v = parse(version)
  const min = parse(minimum)
  if (!v || !min) return true // non-semver → don't block
  for (let i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true
    if (v[i] < min[i]) return false
  }
  return true // equal
}


export interface UpdateResult {
  updated: boolean
  from?: string
  to?: string
  error?: string
}

/**
 * Check npm registry for a newer version and purge opencode's plugin cache
 * so it re-installs on next launch. Does NOT install - just invalidates.
 * Returns the result so the caller can toast the user to restart.
 */
export async function checkForUpdate(): Promise<UpdateResult> {
  const currentVersion = getVersion()
  if (currentVersion === "unknown") return { updated: false }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const res = await fetch("https://registry.npmjs.org/opencode-dir/latest", {
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) return { updated: false }

    const data = (await res.json()) as { version?: string }
    const latest = data.version
    if (!latest) return { updated: false }

    // Already up to date (or running newer/dev)
    if (meetsMinVersion(currentVersion, latest)) return { updated: false }

    // Purge opencode's arborist cache so it re-resolves on next launch.
    // opencode caches npm plugins at: $XDG_CACHE_HOME/opencode/packages/<pkg>/
    // Deleting node_modules + package-lock.json forces Arborist.loadVirtual()
    // to fail, which triggers a fresh reify() with the latest version.
    const home = homedir()
    const cacheBase = resolve(
      process.env.XDG_CACHE_HOME || resolve(home, ".cache"),
      "opencode", "packages", "opencode-dir@latest",
    )
    const { rmSync: rm } = await import("fs")
    try { rm(resolve(cacheBase, "node_modules"), { recursive: true, force: true }) } catch {}
    try { rm(resolve(cacheBase, "package-lock.json"), { force: true }) } catch {}

    return { updated: true, from: currentVersion, to: latest }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Don't report aborts or network errors - expected in offline environments
    if (!msg.includes("abort")) {
      reportError(new Error(`Update check failed: ${msg}`))
    }
    return { updated: false, error: msg }
  }
}


// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Resolves the initial commit hash for a git repository, matching
 * opencode's `Project.fromDirectory` logic:
 * 1. Check `.git/opencode` cache file first (same as opencode)
 * 2. Fall back to `git rev-list --max-parents=0 --all`, sorted, first.
 */
export function getInitialCommit(dir: string): string | null {
  const gitDir = join(dir, ".git")

  if (!existsSync(gitDir)) {
    return null
  }

  // Step 1: Check opencode's cache file first (same as opencode does)
  try {
    const cacheFile = join(gitDir, "opencode")
    if (existsSync(cacheFile)) {
      const cached = readFileSync(cacheFile, "utf-8").trim()
      if (cached) return cached
    }
  } catch {}

  // Step 2: Fall back to git rev-list and CACHE the result (so opencode matches)
  try {
    const output = execSync("git rev-list --max-parents=0 --all", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    const commits = output.split("\n").filter(Boolean).map((x) => x.trim()).sort()
    const id = commits[0] ?? null
    if (id) {
      try {
        const cacheFile = join(gitDir, "opencode")
        writeFileSync(cacheFile, id)
      } catch {}
    }
    return id
  } catch {
    return null
  }
}

/**
 * Resolves the opencode database path, mirroring the logic in
 * `packages/opencode/src/storage/db.ts → Database.getChannelPath()` and
 * `packages/opencode/src/global/index.ts → Global.Path.data`.
 *
 * opencode uses `xdg-basedir` which resolves to:
 *   XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
 * on all platforms (including Windows).
 */
export function getDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir()
  const dataDir = resolve(
    process.env.XDG_DATA_HOME || resolve(homeDir, ".local", "share"),
    "opencode",
  )

  // OPENCODE_DB override (mirrors Flag.OPENCODE_DB)
  const dbOverride = process.env.OPENCODE_DB
  if (dbOverride) {
    if (dbOverride === ":memory:") return dbOverride
    if (isAbsolute(dbOverride)) return dbOverride
    return resolve(dataDir, dbOverride)
  }

  // Channel-based naming
  const channel = process.env.OPENCODE_CHANNEL ?? "latest"
  if (["latest", "beta", "prod"].includes(channel) || process.env.OPENCODE_DISABLE_CHANNEL_DB) {
    return resolve(dataDir, "opencode.db")
  }
  const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return resolve(dataDir, `opencode-${safe}.db`)
}

// Validate that a Database-like object has a working query/run method
function assertValidDb(db: Database, fn: string): void {
  if (!db || typeof db.query !== "function" || typeof db.run !== "function") {
    throw new Error(
      `opencode-dir: invalid database instance passed to ${fn}. ` +
      "The plugin must be called from within the opencode plugin system.",
    )
  }
}

/** Returns true if the database has the tables the plugin needs. */
export function hasSchema(db: Database): boolean {
  assertValidDb(db, "hasSchema")
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
    .get() as { name: string } | null | undefined
  return !!row
}



/**
 * Creates the minimal schema required by the plugin in a fresh database.
 *
 * Only used in tests - production relies on opencode's drizzle migrations.
 */
export function createSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL DEFAULT '[]',
      commands TEXT
    );
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
}

/** Creates a project row if one does not already exist. */
export function ensureProject(db: Database, projectId: string, worktree: string) {
  if (db.query("SELECT id FROM project WHERE id = ?").get(projectId)) return

  const now = Date.now()
  db.run(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
     VALUES (?, ?, ?, ?, '[]')`,
    [projectId, worktree, now, now],
  )
}

function hasPermissionTable(db: Database): boolean {
  try {
    const row = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='permission'`).get() as any
    return !!row
  } catch { return false }
}

/**
 * Updates a session's directory, project, and permission in one statement.
 *
 * Appends an `external_directory` allow rule to `session.permission` so
 * `PermissionNext` auto-allows tool access to the target tree.
 * Preserves existing permission rules (e.g. from prior /cd, /mv, /add-dir).
 * `prompt()` loads the session AFTER `command.execute.before` fires,
 * so the rule is available when tools run.
 * Atomic: session + permission table in one BEGIN IMMEDIATE.
 */
export function updateSession(db: Database, sessionId: string, newDir: string, newProjectId: string): number {
  const existing = getSessionPermissions(db, sessionId)
  const pattern = newDir + "/*"
  const already = existing.some(
    (r: any) => r.permission === "external_directory" && r.pattern === pattern,
  )
  if (!already) {
    existing.push({ permission: "external_directory", pattern, action: "allow" })
  }
  const permission = JSON.stringify(existing)
  const hasPermTable = hasPermissionTable(db)
  let changes = 0
  const tx = db.transaction(() => {
    changes = db.run(
      `UPDATE session SET directory = ?, project_id = ?, permission = ?, time_updated = ? WHERE id = ?`,
      [newDir, newProjectId, permission, Date.now(), sessionId],
    ).changes
    if (changes > 0 && hasPermTable) {
      const row = db
        .query(`SELECT id FROM permission WHERE project_id = ? AND action = 'external_directory' AND resource = ?`)
        .get(newProjectId, pattern) as { id: string } | null
      if (!row) {
        const id = `per_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
        const now = Date.now()
        db.run(
          `INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES (?, ?, 'external_directory', ?, ?, ?)`,
          [id, newProjectId, pattern, now, now],
        )
      }
    }
  })
  tx()
  return changes
}

/**
 * Rewrites `path.cwd` and `path.root` in message data from `oldDir` to
 * `newDir`. Runs inside a transaction for atomicity.
 */
export function rewriteMessages(
  db: Database,
  sessionId: string,
  oldDir: string,
  newDir: string,
): { total: number; rewritten: number } {
  const messages = db
    .query("SELECT id, data FROM message WHERE session_id = ?")
    .all(sessionId) as { id: string; data: string }[]

  let rewritten = 0
  const update = db.prepare("UPDATE message SET data = ? WHERE id = ?")
  const tx = db.transaction(() => {
    for (const msg of messages) {
      const data = JSON.parse(msg.data)
      let changed = false

      if (data.path) {
        if (data.path.cwd === oldDir) {
          data.path.cwd = newDir
          changed = true
        }
        if (data.path.root === oldDir) {
          data.path.root = newDir
          changed = true
        }
      }

      if (changed) {
        update.run(JSON.stringify(data), msg.id)
        rewritten++
      }
    }
  })
  tx()

  return { total: messages.length, rewritten }
}

/**
 * Resolves a user-provided path to an absolute directory and its
 * project ID. Uses the git initial commit hash when available,
 * falls back to "global" for non-git directories.
 */
export function resolveTarget(targetPath: string): { dir: string; projectId: string } {
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  let cleaned = targetPath.trim().replace(/^["']|["']$/g, "").replace(/["']/g, "")
  cleaned = cleaned.replace(/^~/, home)
  // Windows double paste: C:\a\"C:\b" → take last C:\
  let lastWin = -1
  for (let i = cleaned.length - 3; i >= 0; i--) {
    if (/[A-Za-z]/.test(cleaned[i]!) && cleaned[i + 1] === ":" && (cleaned[i + 2] === "\\" || cleaned[i + 2] === "/")) { lastWin = i; break }
  }
  if (lastWin > 0) cleaned = cleaned.slice(lastWin)
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(cleaned)
  const dir = isWinAbs ? cleaned.replace(/\//g, "\\") : resolve(cleaned)

  if (!existsSync(dir)) {
    throw new Error(`Directory does not exist: ${dir}`)
  }

  const projectId = getInitialCommit(dir) ?? "global"
  return { dir, projectId }
}

/** Reads session directory and project ID from the database. */
export function getSessionInfo(
  db: Database,
  sessionId: string,
): { directory: string; projectId: string } | null {
  const row = db
    .query("SELECT directory, project_id FROM session WHERE id = ?")
    .get(sessionId) as { directory: string; project_id: string } | null
  if (!row) return null
  return { directory: row.directory, projectId: row.project_id }
}

/**
 * Scans early assistant messages for `path.cwd` to determine the
 * directory the session was originally operating in.
 */
export function getCurrentDirectory(db: Database, sessionId: string): string | null {
  const rows = db
    .query("SELECT data FROM message WHERE session_id = ? ORDER BY rowid ASC LIMIT 10")
    .all(sessionId) as { data: string }[]

  for (const row of rows) {
    try {
      const data = JSON.parse(row.data)
      if (data.path?.cwd) return data.path.cwd
    } catch {
      continue
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Core operation
// ---------------------------------------------------------------------------

/** Reads existing permission rules from a session row. */
export function getSessionPermissions(db: Database, sessionId: string): unknown[] {
  const row = db
    .query("SELECT permission FROM session WHERE id = ?")
    .get(sessionId) as { permission: string | null } | null
  if (!row || !row.permission) return []
  try {
    return JSON.parse(row.permission)
  } catch {
    return []
  }
}

/**
 * Removes (un-grants) an external_directory permission for a session.
 * Handles both legacy session.permission JSON and new permission table (PermissionSaved).
 * Atomic: both tables in one BEGIN IMMEDIATE.
 */
export function removeDirPermission(db: Database, sessionId: string, dir: string): number {
  const pattern = dir + "/*"
  const info = getSessionInfo(db, sessionId)
  const hasPermTable = hasPermissionTable(db)
  let legacyRemoved = 0
  let savedRemoved = 0
  const tx = db.transaction(() => {
    const existing = getSessionPermissions(db, sessionId)
    const filtered = existing.filter(
      (r: any) => !(r.permission === "external_directory" && r.pattern === pattern),
    )
    legacyRemoved = existing.length - filtered.length
    if (legacyRemoved > 0) {
      db.run(`UPDATE session SET permission = ?, time_updated = ? WHERE id = ?`, [
        JSON.stringify(filtered),
        Date.now(),
        sessionId,
      ])
    }
    if (info && hasPermTable) {
      const res = db.run(
        `DELETE FROM permission WHERE project_id = ? AND action = 'external_directory' AND resource = ?`,
        [info.projectId, pattern],
      )
      savedRemoved = res.changes
    }
  })
  tx()
  const totalRemoved = Math.max(legacyRemoved, savedRemoved)
  return totalRemoved > 0 ? totalRemoved : 0
}

/** Appends an external_directory permission without touching directory or project. Handles both legacy and new tables. Atomic. */
export function appendDirPermission(db: Database, sessionId: string, dir: string): number {
  const pattern = dir + "/*"
  const info = getSessionInfo(db, sessionId)
  if (!info) return 0
  const hasPermTable = hasPermissionTable(db)
  const existing = getSessionPermissions(db, sessionId)

  const alreadyLegacy = existing.some(
    (r: any) => r.permission === "external_directory" && r.pattern === pattern,
  )
  let alreadySaved = false
  if (hasPermTable) {
    try {
      const row = db
        .query(`SELECT id FROM permission WHERE project_id = ? AND action = 'external_directory' AND resource = ?`)
        .get(info.projectId, pattern) as { id: string } | null
      alreadySaved = !!row
    } catch {}
  }
  if (alreadyLegacy && alreadySaved) return -1
  if (alreadyLegacy || alreadySaved) {
    // Repair missing side atomically, still duplicate
    const tx = db.transaction(() => {
      if (!alreadyLegacy) {
        existing.push({ permission: "external_directory", pattern, action: "allow" })
        db.run(`UPDATE session SET permission = ?, time_updated = ? WHERE id = ?`, [
          JSON.stringify(existing),
          Date.now(),
          sessionId,
        ])
      }
      if (!alreadySaved && hasPermTable) {
        const id = `per_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
        const now = Date.now()
        db.run(
          `INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES (?, ?, 'external_directory', ?, ?, ?)`,
          [id, info.projectId, pattern, now, now],
        )
      }
    })
    tx()
    return -1
  }

  let changes = 0
  const tx = db.transaction(() => {
    existing.push({ permission: "external_directory", pattern, action: "allow" })
    changes = db.run(`UPDATE session SET permission = ?, time_updated = ? WHERE id = ?`, [
      JSON.stringify(existing),
      Date.now(),
      sessionId,
    ]).changes
    if (changes > 0 && hasPermTable) {
      const id = `per_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      const now = Date.now()
      db.run(
        `INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES (?, ?, 'external_directory', ?, ?, ?)`,
        [id, info.projectId, pattern, now, now],
      )
    }
  })
  tx()
  return changes === 0 ? 0 : changes
}

export interface ExecResult {
  result: string
  oldDir?: string
  newDir?: string
}

/**
 * Moves a session to a new directory.
 *
 * @param rewrite - When true (`/mv`), rewrites message history paths.
 *   When false (`/cd`), leaves history intact.
 * @param db - Optional database instance (uses default path if omitted).
 */
export function execMove(
  sessionId: string,
  targetPath: string,
  rewrite: boolean,
  db?: Database,
): ExecResult {
  checkGuard()
  const owned = !db
  try {
    const { dir, projectId } = resolveTarget(targetPath)
    if (!db) {
      db = new Database(getDbPath())
    }

    if (!hasSchema(db)) {
      const msg =
        "Error: opencode database does not contain expected tables. " +
        "The plugin may be opening a stale or wrong database file " +
        `(${getDbPath()}). Ensure opencode has been started at least once.`
      reportError(new Error(msg))
      return { result: msg }
    }

    const session = getSessionInfo(db, sessionId)
    if (!session) {
      const msg = `Error: session ${sessionId} not found in database.`
      reportError(new Error(msg))
      return { result: msg }
    }

    const currentDir = getCurrentDirectory(db, sessionId) ?? session.directory
    if (dir === currentDir) {
      return { result: `Already in ${dir} - no change needed.` }
    }

    ensureProject(db, projectId, dir)
    const changes = updateSession(db, sessionId, dir, projectId)
    if (changes === 0) {
      const msg = `Error: session ${sessionId} not found after update.`
      reportError(new Error(msg))
      return { result: msg }
    }

    // Write opencode's cache so it uses the same projectId
    try {
      const cacheFile = join(dir, ".git", "opencode")
      writeFileSync(cacheFile, projectId)
    } catch {}

    const lines = rewrite
      ? (() => {
          const { total, rewritten } = rewriteMessages(db!, sessionId, currentDir, dir)
          return [
            `Session moved: ${currentDir} -> ${dir}`,
            `Project: ${projectId}`,
            `Messages: ${rewritten}/${total} rewritten`,
          ]
        })()
      : [`Session directory changed: ${currentDir} -> ${dir}`, `Project: ${projectId}`]

    lines.push("", `Tools will now operate in ${dir} for this session.`)

    return { oldDir: currentDir, newDir: dir, result: lines.join("\n") }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    reportError(err)
    return { result: `Error: opencode-dir database operation failed - the plugin may need updating.` }
  } finally {
    if (owned && db) db.close()
  }
}

/**
 * Removes tool access to a previously-granted external directory for a session.
 *
 * The session's working directory is left untouched; only the permission
 * entries for the given path are cleared.
 *
 * @param sessionId - Session ID to revoke access from.
 * @param targetPath - Path to the directory being removed.
 * @param db - Optional database instance (uses default path if omitted).
 * @returns Result with a user-facing message.
 */
export function execRemoveDir(
  sessionId: string,
  targetPath: string,
  db?: Database,
): ExecResult {
  checkGuard()
  let dir: string
  try {
    dir = resolveTarget(targetPath).dir
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e))
    reportError(err)
    return { result: `Error: ${err.message}` }
  }

  const owned = !db
  try {
    if (!db) {
      db = new Database(getDbPath())
    }

    if (!hasSchema(db)) {
      const msg =
        "Error: opencode database does not contain expected tables. " +
        "The plugin may be opening a stale or wrong database file " +
        `(${getDbPath()}). Ensure opencode has been started at least once.`
      reportError(new Error(msg))
      return { result: msg }
    }

    const session = getSessionInfo(db, sessionId)
    if (!session) {
      const msg = `Error: session ${sessionId} not found in database.`
      reportError(new Error(msg))
      return { result: msg }
    }

    const rowsRemoved = removeDirPermission(db, sessionId, dir)
    if (rowsRemoved === 0) {
      return { result: `Directory ${dir} is not currently granted in this session.` }
    }

    return {
      result: [
        `Removed directory: ${dir}`,
        `Tools can no longer access files under ${dir} for this session.`,
      ].join("\n"),
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    reportError(err)
    return { result: `Error: opencode-dir database operation failed - the plugin may need updating.` }
  } finally {
    if (owned && db) {
      db.close()
    }
  }
}

/**
 * Grants tool access to an additional directory without changing the
 * session's working directory, project, or message history.
 *
 * @param sessionId - Session ID to grant access to.
 * @param targetPath - Path to the directory to add.
 * @param db - Optional database instance (uses default path if omitted).
 * @returns Number of rows affected (≥ 1 on success, 0 if session not found, -1 for duplicate).
 */
export function execAddDir(
  sessionId: string,
  targetPath: string,
  db?: Database,
): ExecResult {
  checkGuard()
  let dir: string
  try {
    dir = resolveTarget(targetPath).dir
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e))
    reportError(err)
    return { result: `Error: ${err.message}` }
  }

  const owned = !db
  try {
    if (!db) {
      db = new Database(getDbPath())
    }

    if (!hasSchema(db)) {
      const msg =
        "Error: opencode database does not contain expected tables. " +
        "The plugin may be opening a stale or wrong database file " +
        `(${getDbPath()}). Ensure opencode has been started at least once.`
      reportError(new Error(msg))
      return { result: msg }
    }

    const session = getSessionInfo(db, sessionId)
    if (!session) {
      const msg = `Error: session ${sessionId} not found in database.`
      reportError(new Error(msg))
      return { result: msg }
    }

    const status = appendDirPermission(db, sessionId, dir)
    if (status === -1) {
      return { result: `Directory ${dir} is already accessible in this session.` }
    }
    if (status === 0) {
      const msg = `Error: session ${sessionId} not found in database.`
      reportError(new Error(msg))
      return { result: msg }
    }

    return {
      result: [
        `Added directory: ${dir}`,
        `Tools can now access files under ${dir} for this session.`,
      ].join("\n"),
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    reportError(err)
    return { result: `Error: opencode-dir database operation failed - the plugin may need updating.` }
  } finally {
    if (owned && db) db.close()
  }
}

