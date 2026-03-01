import { type Plugin } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { resolve } from "path"
import { existsSync } from "fs"
import { execSync } from "child_process"

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

// Get the actual current directory from the latest assistant message's path.cwd
// This is the source of truth — assistant messages carry path.cwd, user messages don't.
// Note: role is inside the JSON `data` column, not a table column.
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
// Core operations — shared between hook and tools
// ---------------------------------------------------------------------------

function execCd(sessionId: string, targetPath: string): string {
  const { dir, projectId } = resolveTarget(targetPath)

  const db = new Database(getDbPath())
  try {
    const session = getSessionInfo(db, sessionId)
    if (!session) {
      return `Error: session ${sessionId} not found in database.`
    }

    if (session.projectId === "global") {
      return `Error: This session belongs to the "global" project (not a git repo). /cd only works for sessions started inside a git repository.`
    }

    const currentDir = getCurrentDirectory(db, sessionId) ?? session.directory
    if (dir === currentDir) {
      return `Already in ${dir} — no change needed.`
    }

    ensureProject(db, projectId, dir)
    const changes = updateSession(db, sessionId, dir, projectId)

    if (changes === 0) {
      return `Error: session ${sessionId} not found in database.`
    }

    return [
      `Session directory changed: ${currentDir} -> ${dir}`,
      `Project: ${projectId}`,
      ``,
      `NEXT STEPS:`,
      `1. Close this opencode session (Ctrl+C or /exit)`,
      `2. cd ${dir}`,
      `3. opencode`,
      `4. Resume this session from the session list`,
    ].join("\n")
  } finally {
    db.close()
  }
}

function execMv(sessionId: string, targetPath: string): string {
  const { dir, projectId } = resolveTarget(targetPath)

  const db = new Database(getDbPath())
  try {
    const session = getSessionInfo(db, sessionId)
    if (!session) {
      return `Error: session ${sessionId} not found in database.`
    }

    if (session.projectId === "global") {
      return `Error: This session belongs to the "global" project (not a git repo). /mv only works for sessions started inside a git repository.`
    }

    const currentDir = getCurrentDirectory(db, sessionId) ?? session.directory
    if (dir === currentDir) {
      return `Already in ${dir} — no change needed.`
    }

    ensureProject(db, projectId, dir)
    updateSession(db, sessionId, dir, projectId)

    // Use currentDir (from messages) as oldDir for rewriting, not session.directory
    const { total, rewritten } = rewriteMessages(db, sessionId, currentDir, dir)

    return [
      `Session moved: ${currentDir} -> ${dir}`,
      `Project: ${projectId}`,
      `Messages: ${rewritten}/${total} rewritten`,
      ``,
      `NEXT STEPS:`,
      `1. Close this opencode session (Ctrl+C or /exit)`,
      `2. cd ${dir}`,
      `3. opencode`,
      `4. Resume this session from the session list`,
    ].join("\n")
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const OpencodeDir: Plugin = async ({ directory, client }) => {
  return {
    // -----------------------------------------------------------------------
    // Deterministic command execution via hook
    // The work is done HERE, before the LLM runs. The LLM just gets the
    // result as its input and acknowledges it.
    // -----------------------------------------------------------------------
    "command.execute.before": async (input, output) => {
      if (input.command !== "cd" && input.command !== "mv") return

      const targetPath = input.arguments.trim()
      if (!targetPath) {
        // Mutate in place — output.parts is a reference to a local variable
        // in the caller, so reassigning output.parts won't propagate.
        output.parts.length = 0
        output.parts.push({
          type: "text",
          text: `Usage: /${input.command} <path>`,
        })
        return
      }

      let result: string
      let targetDir: string | undefined
      try {
        if (input.command === "cd") {
          result = execCd(input.sessionID, targetPath)
        } else {
          result = execMv(input.sessionID, targetPath)
        }

        // Extract target directory from result for toast
        const match = result.match(/-> (.+)/)
        targetDir = match?.[1]
      } catch (err: any) {
        result = `Error: ${err.message}`
      }

      // Mutate in place — see note above
      output.parts.length = 0
      output.parts.push({ type: "text", text: result })

      // Show toast notification with clear instructions
      if (targetDir && !result.startsWith("Error")) {
        await client.tui.showToast({
          body: {
            title: "⚠️ SESSION DIRECTORY CHANGED",
            message: `Moved to ${targetDir}.\n\n🛑 CLOSE OPENCODE NOW (Ctrl+C or /exit)\nThen: cd ${targetDir} && opencode`,
            variant: "warning",
            duration: 30000, // 30 seconds
          },
        })
      }
    },
  }
}
