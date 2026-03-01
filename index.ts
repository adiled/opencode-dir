import { type Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { resolve } from "path"
import { existsSync, appendFileSync, readFileSync, writeFileSync } from "fs"
import { execSync } from "child_process"

const LOG_FILE = "/tmp/opencode-dir-debug.log"
function log(...args: any[]) {
  const ts = new Date().toISOString()
  appendFileSync(LOG_FILE, `[${ts}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`)
}

// ---------------------------------------------------------------------------
// Persistent overrides — survives instance dispose/reload
// ---------------------------------------------------------------------------

const OVERRIDES_FILE = "/tmp/opencode-dir-overrides.json"

type Override = { oldDir: string; newDir: string }

function loadOverrides(): Map<string, Override> {
  try {
    const raw = readFileSync(OVERRIDES_FILE, "utf-8")
    const entries = JSON.parse(raw) as [string, Override][]
    return new Map(entries)
  } catch {
    return new Map()
  }
}

function persistOverrides(map: Map<string, Override>): void {
  try {
    writeFileSync(OVERRIDES_FILE, JSON.stringify([...map.entries()]))
  } catch (e: any) {
    log("persistOverrides error", { message: e.message })
  }
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function getDbPath(): string {
  const dataHome =
    process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`
  return `${dataHome}/opencode/opencode.db`
}

function getInitialCommit(dir: string): string | null {
  try {
    // Match opencode's Project.fromDirectory logic exactly:
    // git rev-list --max-parents=0 --all → split, filter, trim, sort → take [0]
    const output = execSync("git rev-list --max-parents=0 --all", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    const roots = output
      .split("\n")
      .filter(Boolean)
      .map((x) => x.trim())
      .sort()
    return roots[0] ?? null
  } catch {
    return null
  }
}

function ensureProject(
  db: Database,
  projectId: string,
  worktree: string,
): void {
  const existing = db
    .query("SELECT id FROM project WHERE id = ?")
    .get(projectId)
  if (existing) return

  const now = Date.now()
  db.run(
    `INSERT INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands)
     VALUES (?, ?, 'git', NULL, NULL, 'blue', ?, ?, NULL, '[]', NULL)`,
    [projectId, worktree, now, now],
  )
}

function updateSession(
  db: Database,
  sessionId: string,
  newDir: string,
  newProjectId: string,
): number {
  const result = db.run(
    `UPDATE session SET directory = ?, project_id = ?, time_updated = ? WHERE id = ?`,
    [newDir, newProjectId, Date.now(), sessionId],
  )
  return result.changes
}

function rewriteMessages(
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

  return { total: messages.length, rewritten }
}

function resolveTarget(targetPath: string): {
  dir: string
  projectId: string
} {
  const dir = resolve(targetPath.replace(/^~/, process.env.HOME || "/root"))

  if (!existsSync(dir)) {
    throw new Error(`Directory does not exist: ${dir}`)
  }

  const projectId = getInitialCommit(dir)
  if (!projectId) {
    throw new Error(
      `Target directory is not inside a git repository.\n` +
        `/cd and /mv only work with git repos — non-git directories share a single "global" project in opencode, making session moves unreliable.`,
    )
  }

  return { dir, projectId }
}

function getSessionInfo(
  db: Database,
  sessionId: string,
): { directory: string; projectId: string } | null {
  const row = db
    .query("SELECT directory, project_id FROM session WHERE id = ?")
    .get(sessionId) as { directory: string; project_id: string } | null

  if (!row) return null
  return { directory: row.directory, projectId: row.project_id }
}

// Get the actual current directory from the earliest assistant message's path.cwd.
// We scan the first 10 messages to find the original directory — this way if the
// user did /cd first (which doesn't rewrite messages), a later /mv can still find
// the original paths to rewrite.
function getCurrentDirectory(db: Database, sessionId: string): string | null {
  const rows = db
    .query(
      "SELECT data FROM message WHERE session_id = ? ORDER BY rowid ASC LIMIT 10",
    )
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
// Permission helpers — write directly to the permission table so
// PermissionNext.state() picks up the allow rule after instance reload.
// ---------------------------------------------------------------------------

function ensurePermission(
  db: Database,
  projectId: string,
  newDir: string,
): void {
  // The permission table stores a JSON array of {permission, pattern, action}
  // per project_id. We add a single catch-all rule for external_directory
  // that covers newDir and all nested paths.
  const glob = newDir + "/*"
  const rule = { permission: "external_directory", pattern: glob, action: "allow" }

  const row = db
    .query("SELECT data FROM permission WHERE project_id = ?")
    .get(projectId) as { data: string } | null

  const now = Date.now()

  if (row) {
    const existing = JSON.parse(row.data) as any[]
    // Avoid duplicates
    const alreadyExists = existing.some(
      (r: any) =>
        r.permission === rule.permission && r.pattern === rule.pattern && r.action === rule.action,
    )
    if (alreadyExists) return
    existing.push(rule)
    db.run(
      "UPDATE permission SET data = ?, time_updated = ? WHERE project_id = ?",
      [JSON.stringify(existing), now, projectId],
    )
  } else {
    db.run(
      "INSERT INTO permission (project_id, data, time_created, time_updated) VALUES (?, ?, ?, ?)",
      [projectId, JSON.stringify([rule]), now, now],
    )
  }
  log("ensurePermission: wrote rule", { projectId, glob })
}

// ---------------------------------------------------------------------------
// Runtime path rewriting — intercept tool calls after /cd or /mv
// ---------------------------------------------------------------------------

// Per-session directory overrides: sessionId -> { oldDir, newDir }
// Initialised from disk so we survive instance dispose/reload cycles.
const dirOverrides = loadOverrides()

function rewritePath(
  filePath: string,
  oldDir: string,
  newDir: string,
): string {
  if (filePath === oldDir) return newDir
  if (filePath.startsWith(oldDir + "/")) {
    return newDir + filePath.slice(oldDir.length)
  }
  return filePath
}

// Tools that carry file paths in their args
const PATH_TOOLS: Record<string, string[]> = {
  read: ["filePath"],
  write: ["filePath"],
  edit: ["filePath"],
  glob: ["path"],
  grep: ["path"],
  bash: ["workdir"],
  list: ["path"],
  webfetch: [], // no path args
  task: [], // no path args
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

function execCd(sessionId: string, targetPath: string): { result: string; oldDir?: string; newDir?: string } {
  log("execCd", { sessionId, targetPath })
  const { dir, projectId } = resolveTarget(targetPath)

  const db = new Database(getDbPath())
  try {
    const session = getSessionInfo(db, sessionId)
    if (!session) {
      return { result: `Error: session ${sessionId} not found in database.` }
    }

    if (session.projectId === "global") {
      return { result: `Error: This session belongs to the "global" project (not a git repo). /cd only works for sessions started inside a git repository.` }
    }

    const currentDir = getCurrentDirectory(db, sessionId) ?? session.directory
    if (dir === currentDir) {
      return { result: `Already in ${dir} — no change needed.` }
    }

    ensureProject(db, projectId, dir)
    ensurePermission(db, projectId, dir)
    const changes = updateSession(db, sessionId, dir, projectId)

    if (changes === 0) {
      return { result: `Error: session ${sessionId} not found in database.` }
    }

    // Also write permission for the SOURCE project so that tools can
    // still cross-reference the old directory if needed.
    ensurePermission(db, session.projectId, dir)

    return {
      oldDir: currentDir,
      newDir: dir,
      result: [
        `Session directory changed: ${currentDir} -> ${dir}`,
        `Project: ${projectId}`,
        ``,
        `Tools will now operate in ${dir} for this session.`,
        `Restart opencode in the new directory for a clean slate.`,
      ].join("\n"),
    }
  } finally {
    db.close()
  }
}

function execMv(sessionId: string, targetPath: string): { result: string; oldDir?: string; newDir?: string } {
  log("execMv", { sessionId, targetPath })
  const { dir, projectId } = resolveTarget(targetPath)

  const db = new Database(getDbPath())
  try {
    const session = getSessionInfo(db, sessionId)
    if (!session) {
      return { result: `Error: session ${sessionId} not found in database.` }
    }

    if (session.projectId === "global") {
      return { result: `Error: This session belongs to the "global" project (not a git repo). /mv only works for sessions started inside a git repository.` }
    }

    const currentDir = getCurrentDirectory(db, sessionId) ?? session.directory
    if (dir === currentDir) {
      return { result: `Already in ${dir} — no change needed.` }
    }

    ensureProject(db, projectId, dir)
    ensurePermission(db, projectId, dir)
    updateSession(db, sessionId, dir, projectId)

    const { total, rewritten } = rewriteMessages(db, sessionId, currentDir, dir)

    // Also write permission for the SOURCE project
    ensurePermission(db, session.projectId, dir)

    return {
      oldDir: currentDir,
      newDir: dir,
      result: [
        `Session moved: ${currentDir} -> ${dir}`,
        `Project: ${projectId}`,
        `Messages: ${rewritten}/${total} rewritten`,
        ``,
        `Tools will now operate in ${dir} for this session.`,
        `Restart opencode in the new directory for a clean slate.`,
      ].join("\n"),
    }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const OpencodeDir: Plugin = async ({ directory, client }) => {
  log("plugin loaded", { directory, overridesRecovered: dirOverrides.size })

  return {
    // -----------------------------------------------------------------
    // /cd and /mv command handler
    // -----------------------------------------------------------------
    "command.execute.before": async (input, output) => {
      log("command.execute.before", { command: input.command, sessionID: input.sessionID, arguments: input.arguments })
      if (input.command !== "cd" && input.command !== "mv") return

      const targetPath = input.arguments.trim()
      if (!targetPath) {
        output.parts.length = 0
        output.parts.push({
          type: "text",
          text: `Usage: /${input.command} <path>`,
        })
        return
      }

      let exec: { result: string; oldDir?: string; newDir?: string }
      try {
        exec =
          input.command === "cd"
            ? execCd(input.sessionID, targetPath)
            : execMv(input.sessionID, targetPath)
      } catch (err: any) {
        exec = { result: `Error: ${err.message}` }
      }

      output.parts.length = 0
      output.parts.push({ type: "text", text: exec.result })

      // If the move/cd succeeded, register the override for runtime interception
      if (exec.oldDir && exec.newDir) {
        log("storing override", { sessionID: input.sessionID, oldDir: exec.oldDir, newDir: exec.newDir })
        dirOverrides.set(input.sessionID, {
          oldDir: exec.oldDir,
          newDir: exec.newDir,
        })
        persistOverrides(dirOverrides)

        // Change process cwd so bash tools default to the new directory
        try {
          process.chdir(exec.newDir)
        } catch {
          // May fail if directory doesn't exist yet — non-fatal
        }

        // Allow external_directory permission via the GLOBAL config.
        // client.global.config.update() writes to ~/.config/opencode/opencode.json
        // and triggers Instance.disposeAll() → full reload. The DB permission
        // rule we already wrote in execCd/execMv will be picked up by
        // PermissionNext.state() after reload. The global config rule provides
        // a second layer that applies across all projects/instances.
        try {
          const glob = exec.newDir + "/*"
          log("updating global config to allow external_directory", { glob })
          await client.global.config.update({
            config: {
              permission: {
                external_directory: {
                  [glob]: "allow",
                },
              },
            },
          })
          log("global config updated — instance will reload")
        } catch (e: any) {
          log("global config update error", { message: e.message, stack: e.stack })
        }

        await client.tui.showToast({
          body: {
            title: "Session directory changed",
            message: `Now operating in ${exec.newDir}.\nRestart opencode there for a clean slate.`,
            variant: "info",
            duration: 8000,
          },
        }).catch(() => {
          // Toast may fail if instance is mid-dispose — non-fatal
        })
      }
    },

    // -----------------------------------------------------------------
    // Intercept tool calls to rewrite file paths
    // -----------------------------------------------------------------
    "tool.execute.before": async (input, output) => {
      const override = dirOverrides.get(input.sessionID)
      log("tool.execute.before", { tool: input.tool, sessionID: input.sessionID, hasOverride: !!override, argsBefore: output.args })
      if (!override) return

      const { oldDir, newDir } = override
      const pathKeys = PATH_TOOLS[input.tool]

      // Rewrite known path args
      if (pathKeys) {
        for (const key of pathKeys) {
          if (typeof output.args[key] === "string") {
            output.args[key] = rewritePath(output.args[key], oldDir, newDir)
          }
        }
      }

      // For bash: inject workdir if missing (bash falls back to
      // Instance.directory, not process.cwd), and rewrite absolute
      // paths in the command string
      if (input.tool === "bash") {
        if (!output.args.workdir) {
          log("injecting workdir", { newDir })
          output.args.workdir = newDir
        }
        if (typeof output.args.command === "string") {
          output.args.command = output.args.command.replaceAll(oldDir, newDir)
        }
      }
      log("tool.execute.before DONE", { argsAfter: output.args })
    },

    // -----------------------------------------------------------------
    // Inject correct PWD for shell executions
    // -----------------------------------------------------------------
    "shell.env": async (input, output) => {
      log("shell.env", { cwd: input.cwd, sessionID: input.sessionID })
      const override = dirOverrides.get(input.sessionID ?? "")
      if (!override) return

      const { oldDir, newDir } = override
      if (input.cwd === oldDir || input.cwd.startsWith(oldDir + "/")) {
        output.env.PWD = rewritePath(input.cwd, oldDir, newDir)
      }
    },
  }
}
