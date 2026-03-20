import { Database } from "bun:sqlite"
import { resolve } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { execSync } from "child_process"

// ---------------------------------------------------------------------------
// Commands installation
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, string> = {
  cd: `---
description: Change session working directory
---

Change the session's working directory to $ARGUMENTS. Tools will operate in the new directory immediately. Message history is left untouched.`,
  mv: `---
description: Move session and rewrite paths
---

Move the session to $ARGUMENTS and rewrite path.cwd/root in all message history. Use when you want full context to reflect the new location.`,
}

export function installCommands(): void {
  try {
    const cmdsDst = resolve(
      process.env.OPENCODE_CONFIG_DIR ?? `${process.env.HOME}/.config/opencode`,
      "commands",
    )
    if (!existsSync(cmdsDst)) mkdirSync(cmdsDst, { recursive: true })

    for (const [name, content] of Object.entries(COMMANDS)) {
      const dst = resolve(cmdsDst, `${name}.md`)
      if (!existsSync(dst)) {
        writeFileSync(dst, content, { mode: 0o644 })
      }
    }
  } catch {
    // Silently skip if commands can't be installed — plugin still works
  }
}

// ---------------------------------------------------------------------------
// Error telemetry (zero-dep Sentry envelope API)
// ---------------------------------------------------------------------------

const SENTRY_DSN = "https://3dc34b92b6635091e8f0feba7bf6f9c5@o4510982366625792.ingest.us.sentry.io/4510982373769216"

let _version: string | undefined

function getVersion(): string {
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

/** Reports an error to Sentry. Silent on failure — must never break the plugin. */
export async function reportError(err: Error) {
  try {
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
    // Silent — telemetry must never break the plugin
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
// Git
// ---------------------------------------------------------------------------

/**
 * Resolves the initial commit hash for a git repository, matching
 * opencode's `Project.fromDirectory` logic:
 * `git rev-list --max-parents=0 --all`, split/filter/sort, take first.
 */
export function getInitialCommit(dir: string): string | null {
  try {
    const output = execSync("git rev-list --max-parents=0 --all", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    return output.split("\n").filter(Boolean).map((x) => x.trim()).sort()[0] ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Creates the minimal schema required by the plugin in a fresh database. */
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

/**
 * Updates a session's directory, project, and permission in one statement.
 *
 * Writes an `external_directory` allow rule to `session.permission` so
 * `PermissionNext` auto-allows tool access to the target tree.
 * `prompt()` loads the session AFTER `command.execute.before` fires,
 * so the rule is available when tools run.
 */
export function updateSession(db: Database, sessionId: string, newDir: string, newProjectId: string): number {
  const permission = JSON.stringify([
    { permission: "external_directory", pattern: newDir + "/*", action: "allow" },
  ])
  return db.run(
    `UPDATE session SET directory = ?, project_id = ?, permission = ?, time_updated = ? WHERE id = ?`,
    [newDir, newProjectId, permission, Date.now(), sessionId],
  ).changes
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
  const dir = resolve(targetPath.replace(/^~/, process.env.HOME || "/root"))

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
  const { dir, projectId } = resolveTarget(targetPath)
  const owned = !db
  if (!db) {
    const stateDir = `${process.env.XDG_DATA_HOME || process.env.HOME + "/.local/share"}/opencode`
    db = new Database(`${stateDir}/opencode.db`)
  }

  try {
    const session = getSessionInfo(db, sessionId)
    if (!session) {
      return { result: `Error: session ${sessionId} not found in database.` }
    }

    const currentDir = getCurrentDirectory(db, sessionId) ?? session.directory
    if (dir === currentDir) {
      return { result: `Already in ${dir} — no change needed.` }
    }

    ensureProject(db, projectId, dir)
    const changes = updateSession(db, sessionId, dir, projectId)
    if (changes === 0) {
      return { result: `Error: session ${sessionId} not found in database.` }
    }

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
    // Report full detail to Sentry, collapse for user
    const err = e instanceof Error ? e : new Error(String(e))
    reportError(err)
    return { result: `Error: opencode-dir database operation failed — the plugin may need updating.` }
  } finally {
    if (owned) db.close()
  }
}

