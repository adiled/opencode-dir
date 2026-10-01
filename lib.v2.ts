import { appendFileSync, mkdirSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, isAbsolute, join, relative, resolve } from "path"
import { randomUUID } from "crypto"
import { createRequire } from "module"

export type V2Effect = "allow" | "deny" | "ask"
export type V2Rule = { action: string; resource: string; effect: V2Effect }
export type V2Ruleset = readonly V2Rule[]

export type V2Delivery = "steer" | "queue"

export interface V2Invocation {
  sessionID: string
  prompt: { text: string }
  delivery: V2Delivery
}

export interface V2CommandDefinition {
  name: string
  description?: string
  execute: (input: V2Invocation) => Promise<void>
}

export interface V2CommandEditor {
  add(definition: V2CommandDefinition): void
}

export interface V2SessionInfo {
  id: string
  projectID?: string
  location: { directory: string; workspaceID?: string }
  permissions?: V2Ruleset
}

export interface V2Context {
  options: Record<string, unknown>
  app: { name: string; version: string; channel: string }
  command: {
    transform(cb: (editor: V2CommandEditor) => void): Promise<{ dispose(): Promise<void> }>
  }
  session: {
    get(input: { sessionID: string }): Promise<V2SessionInfo>
    move(input: { sessionID: string; directory: string; delivery?: V2Delivery }): Promise<void>
    update(input: { sessionID: string; permissions?: V2Rule[] }): Promise<void>
    synthetic(input: { sessionID: string; text: string; description?: string }): Promise<void>
  }
  tool: {
    hook(name: "execute.before", cb: (input: { tool: string; sessionID: string; input: unknown }) => void | Promise<void>): Promise<{ dispose(): Promise<void> }>
  }
  shell: {
    hook(name: "create.before", cb: (input: { cwd: string; env: Record<string, string | undefined> }) => void | Promise<void>): Promise<{ dispose(): Promise<void> }>
  }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
}

const SERVICE = "opencode-dir"

export function getDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  return resolve(process.env.XDG_DATA_HOME || resolve(home, ".local", "share"), "opencode")
}

export function getV2LogPath(): string {
  return resolve(getDataDir(), "log", "opencode-dir-v2.log")
}

let logFileChecked = false
function ensureLogDir(): string | null {
  const path = getV2LogPath()
  if (!logFileChecked) {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {}
    logFileChecked = true
  }
  return path
}

export function serializeV2Log(fields: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    service: SERVICE,
    surface: "v2",
    ...fields,
  })
}

export function v2Log(fields: Record<string, unknown>): void {
  const path = ensureLogDir()
  if (!path) return
  try {
    appendFileSync(path, serializeV2Log(fields) + "\n")
  } catch {}
}

export function externalDirectoryResource(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "") + "/*"
}

export function appendExternalDirectory(
  rules: V2Ruleset,
  dir: string,
): { rules: V2Rule[]; added: boolean; resource: string } {
  const resource = externalDirectoryResource(dir)
  if (rules.some((r) => r.action === "external_directory" && r.resource === resource)) {
    return { rules: [...rules], added: false, resource }
  }
  return { rules: [...rules, { action: "external_directory", resource, effect: "allow" }], added: true, resource }
}

export function removeExternalDirectory(
  rules: V2Ruleset,
  dir: string,
): { rules: V2Rule[]; removed: boolean; resource: string } {
  const resource = externalDirectoryResource(dir)
  const next = rules.filter((r) => !(r.action === "external_directory" && r.resource === resource))
  return { rules: next, removed: next.length !== rules.length, resource }
}

export function extractTargetArgument(promptText: string): string {
  return promptText.trim().replace(/^["']|["']$/g, "").replace(/["']/g, "")
}

export type V2Outcome = { status: "ok"; result: string } | { status: "info"; result: string } | { status: "error"; result: string }

export type V2Toast = { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }

const ToastPayload = {
  type: "object",
  properties: {
    title: { type: "string" },
    message: { type: "string" },
    variant: { type: "string", enum: ["info", "success", "warning", "error"] },
    duration: { type: "number" },
  },
  required: ["message"],
} as const

export const TOAST_RPC = {
  id: "opencode-dir",
  methods: {},
  events: { toast: { schema: ToastPayload } },
} as const

export interface V2Deps {
  resolveDir: (raw: string) => { dir: string }
  overrides: Map<string, string>
  persistOverrides: (map: Map<string, string>) => void
  openDb?: () => unknown
  toast?: (input: V2Toast) => void
}

export function getV2DbPath(): string {
  return resolve(getDataDir(), "opencode.db")
}

export function openV2Db(): V2DbLike {
  const mod = createRequire(import.meta.url)("./db.js") as { Database: new (path: string) => V2DbLike }
  return new mod.Database(getV2DbPath())
}

export interface V2SessionRow {
  directory: string | null
  project_id: string | null
  path: string | null
  permission: string | null
}

export interface V2ProjectRow {
  id: string
  worktree: string | null
}

export interface V2DbLike {
  query(sql: string): {
    all(...args: unknown[]): unknown[]
    get(...args: unknown[]): unknown
  }
  run(sql: string, args?: unknown[]): { changes: number }
  transaction<T>(cb: () => T): () => T
  close(): void
}

export function v2SubpathFor(worktree: string | null | undefined, dir: string): string | null {
  if (!worktree) return null
  const rel = relative(worktree, dir).replaceAll("\\", "/")
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null
  return rel
}

export function v2UpdateSession(
  db: V2DbLike,
  sessionId: string,
  newDir: string,
  newProjectId: string,
): number {
  const existing = readV2Rules(sessionId, db)
  const pattern = externalDirectoryResource(newDir)
  const already = existing.some((r) => r.action === "external_directory" && r.resource === pattern)
  if (!already) {
    existing.push({ action: "external_directory", resource: pattern, effect: "allow" })
  }
  const permission = JSON.stringify(existing)
  const project = db
    .query("SELECT id, worktree FROM project WHERE id = ?")
    .get(newProjectId) as V2ProjectRow | undefined
  const subpath = v2SubpathFor(project?.worktree, newDir)
  let changes = 0
  const tx = db.transaction(() => {
    changes = db.run(
      "UPDATE session_v2 SET directory = ?, project_id = ?, path = ?, permission = ?, time_updated = ? WHERE id = ?",
      [newDir, newProjectId, subpath, permission, Date.now(), sessionId],
    ).changes
    if (changes > 0) {
      const row = db
        .query(
          "SELECT id FROM permission WHERE project_id = ? AND action = 'external_directory' AND resource = ?",
        )
        .get(newProjectId, pattern) as { id: string } | undefined
      if (!row) {
        const id = `per_${randomUUID().replace(/-/g, "").slice(0, 16)}`
        const now = Date.now()
        db.run(
          "INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES (?, ?, 'external_directory', ?, ?, ?)",
          [id, newProjectId, pattern, now, now],
        )
      }
    }
  })
  tx()
  return changes
}

export function ensureV2Project(db: V2DbLike, worktree: string): string {
  const found = db.query("SELECT id, worktree FROM project WHERE worktree = ?").get(worktree) as
    | V2ProjectRow
    | undefined
  if (found) return found.id
  const id = `prj_${randomUUID().replace(/-/g, "").slice(0, 16)}`
  const now = Date.now()
  db.run(
    "INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, worktree, "git", now, now, 0, "[]"],
  )
  return id
}

export function readV2SessionRow(db: V2DbLike, sessionId: string): V2SessionRow | undefined {
  return db
    .query("SELECT directory, project_id, path, permission FROM session_v2 WHERE id = ?")
    .get(sessionId) as V2SessionRow | undefined
}

export function readV2Rules(sessionId: string, db: V2DbLike): V2Rule[] {
  const row = readV2SessionRow(db, sessionId)
  if (!row?.permission) return []
  try {
    const parsed = JSON.parse(row.permission)
    return Array.isArray(parsed) ? (parsed as V2Rule[]) : []
  } catch {
    return []
  }
}

export function v2RewriteMessages(
  db: V2DbLike,
  sessionId: string,
  oldDir: string,
  newDir: string,
): { total: number; rewritten: number; skipped: number } {
  const messages = db
    .query("SELECT id, data FROM session_message WHERE session_id = ?")
    .all(sessionId) as { id: string; data: string }[]

  let rewritten = 0
  let skipped = 0
  const tx = db.transaction(() => {
    for (const msg of messages) {
      type StoredMessage = {
        role?: unknown
        time?: { created?: unknown; completed?: unknown }
        path?: { cwd?: unknown; root?: unknown }
      }
      let data: StoredMessage
      try {
        data = JSON.parse(msg.data) as StoredMessage
      } catch {
        continue
      }
      if (data.role === "assistant" && data.time?.created !== undefined && data.time?.completed === undefined) {
        skipped++
        continue
      }
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
        db.run("UPDATE session_message SET data = ? WHERE id = ?", [JSON.stringify(data), msg.id])
        rewritten++
      }
    }
  })
  tx()
  return { total: messages.length, rewritten, skipped }
}

function usage(command: string): V2Outcome {
  return { status: "error", result: `Usage: /${command} <path>` }
}

export async function runV2Command(
  deps: V2Deps,
  ctx: V2Context,
  command: "cd" | "mv" | "add-dir" | "remove-dir",
  invocation: V2Invocation,
): Promise<V2Outcome> {
  const { sessionID } = invocation
  const target = extractTargetArgument(invocation.prompt.text)
  v2Log({ event: "command.invoke", command, sessionID, target })

  if (!target) {
    const outcome = usage(command)
    v2Log({ event: "command.usage", command, sessionID, outcome })
    return outcome
  }

  let dir: string
  try {
    dir = deps.resolveDir(target).dir
  } catch (e) {
    const result = e instanceof Error ? e.message : String(e)
    v2Log({ event: "command.resolve.failed", command, sessionID, target, result })
    return { status: "error", result }
  }

  v2Log({ event: "command.resolved", command, sessionID, target, dir })

  if (command === "cd" || command === "mv") {
    let info: V2SessionInfo | null = null
    try {
      info = await ctx.session.get({ sessionID })
    } catch (e) {
      v2Log({ event: "session.get.failed", command, sessionID, result: String(e) })
    }

    const current = info?.location.directory ?? ""
    if (current && current === dir) {
      v2Log({ event: "session.move.skip", command, sessionID, dir })
      return { status: "info", result: `Already in ${dir} - no change needed.` }
    }

    if (!deps.openDb) {
      const msg = "opencode-dir database is unavailable - cannot move this session."
      v2Log({ event: "session.move.failed", command, sessionID, from: current, to: dir, result: msg })
      return { status: "error", result: msg }
    }

    let changes = 0
    let rewriteStats = { total: 0, rewritten: 0, skipped: 0 }
    try {
      const db = deps.openDb() as V2DbLike
      try {
        const projectId = ensureV2Project(db, dir)
        changes = v2UpdateSession(db, sessionID, dir, projectId)
        if (changes === 0) {
          const msg = `session ${sessionID} not found in database.`
          v2Log({ event: "session.move.failed", command, sessionID, from: current, to: dir, result: msg })
          return { status: "error", result: msg }
        }
        if (command === "mv" && current) {
          rewriteStats = v2RewriteMessages(db, sessionID, current, dir)
          v2Log({ event: "messages.rewritten", command, sessionID, ...rewriteStats })
        }
        try {
          writeFileSync(join(dir, ".git", "opencode"), projectId)
        } catch {}
      } finally {
        db.close()
      }
    } catch (e) {
      const result = e instanceof Error ? e.message : String(e)
      v2Log({ event: "session.move.failed", command, sessionID, from: current, to: dir, result })
      return {
        status: "error",
        result: "opencode-dir database operation failed - the plugin may need updating.",
      }
    }

    v2Log({ event: "session.move.ok", command, sessionID, from: current, to: dir, changes })

    if (current && current !== dir) {
      deps.overrides.set(sessionID, dir)
      deps.persistOverrides(deps.overrides)
      v2Log({ event: "override.set", sessionID, from: current, to: dir, count: deps.overrides.size })
    }

    const lines: string[] =
      command === "mv"
        ? [
            `Session moved: ${current} -> ${dir}`,
            `Messages: ${rewriteStats.rewritten}/${rewriteStats.total} rewritten${
              rewriteStats.skipped > 0 ? `, ${rewriteStats.skipped} skipped (in-flight turn)` : ""
            }`,
          ]
        : [`Session directory changed: ${current} -> ${dir}`]
    lines.push("", `Tools will now operate in ${dir} for this session.`)
    return { status: "ok", result: lines.join("\n") }
  }

  let rules: V2Ruleset = []
  try {
    rules = (await ctx.session.get({ sessionID })).permissions ?? []
  } catch (e) {
    const result = e instanceof Error ? e.message : String(e)
    v2Log({ event: "session.get.failed", command, sessionID, result })
    return { status: "error", result }
  }

  v2Log({ event: "permissions.read", command, sessionID, dir, count: rules.length, rules })

  const next: V2Rule[] = []
  let resource = ""
  let changed = false

  if (command === "add-dir") {
    const applied = appendExternalDirectory(rules, dir)
    next.push(...applied.rules)
    resource = applied.resource
    changed = applied.added
    if (!changed) {
      v2Log({ event: "permissions.skip", command, sessionID, dir, resource })
      return { status: "info", result: `${dir} is already an accessible working directory` }
    }
  } else {
    const applied = removeExternalDirectory(rules, dir)
    next.push(...applied.rules)
    resource = applied.resource
    changed = applied.removed
    if (!changed) {
      v2Log({ event: "permissions.skip", command, sessionID, dir, resource })
      return { status: "info", result: `${dir} was not an accessible working directory` }
    }
  }

  try {
    await ctx.session.update({ sessionID, permissions: next })
  } catch (e) {
    const result = e instanceof Error ? e.message : String(e)
    v2Log({ event: "session.update.failed", command, sessionID, dir, result })
    return { status: "error", result: `Could not update permissions: ${result}` }
  }

  v2Log({
    event: "session.update.ok",
    command,
    sessionID,
    dir,
    resource,
    before: rules.length,
    after: next.length,
  })

  return command === "add-dir"
    ? { status: "ok", result: `${dir} added as a working directory` }
    : { status: "ok", result: `${dir} is no longer an accessible working directory` }
}

const DESCRIPTIONS: Record<string, string> = {
  cd: "Move this session to another directory in the current project",
  mv: "Move this session to another directory in the current project",
  "add-dir": "Grant tools access to an additional directory",
  "remove-dir": "Revoke tool access to an additional directory",
}

export function buildV2Commands(deps: V2Deps, ctx: V2Context): V2CommandDefinition[] {
  const names = ["cd", "mv", "add-dir", "remove-dir"] as const
  return names.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    execute: async (invocation: V2Invocation) => {
      const outcome = await runV2Command(deps, ctx, name, invocation)
      const text = `opencode-dir: ${outcome.result}`
      v2Log({ event: "command.surface", command: name, sessionID: invocation.sessionID, outcome })
      if (deps.toast) {
        try {
          deps.toast({
            title: outcome.status === "error" ? "opencode-dir" : "opencode-dir",
            message: outcome.result,
            variant: outcome.status === "error" ? "error" : outcome.status === "info" ? "info" : "success",
            duration: outcome.status === "error" ? 8000 : 5000,
          })
        } catch (e) {
          v2Log({ event: "toast.failed", command: name, result: String(e) })
        }
      }
      await ctx.session
        .synthetic({
          sessionID: invocation.sessionID,
          text,
          description: outcome.status,
        })
        .catch((e) => {
          v2Log({ event: "synthetic.failed", command: name, sessionID: invocation.sessionID, result: String(e) })
        })
    },
  }))
}

export async function setupV2(ctx: V2Context, deps: V2Deps): Promise<{ dispose(): Promise<void> }> {
  v2Log({
    event: "setup.start",
    app: ctx.app,
    options: ctx.options,
    overridesRecovered: deps.overrides.size,
  })

  const commands = buildV2Commands(deps, ctx)
  v2Log({ event: "setup.commands", names: commands.map((c) => c.name) })

  const commandReg = await ctx.command.transform((editor) => {
    for (const definition of commands) {
      editor.add(definition)
      v2Log({ event: "setup.command.registered", name: definition.name, description: definition.description })
    }
  })

  const toolReg = await ctx.tool.hook("execute.before", (input) => {
    const override = deps.overrides.get(input.sessionID)
    if (!override) return
    const args = input.input as Record<string, unknown> | null
    if (!args || typeof args !== "object") return
    let touched = false
    if (input.tool === "bash" && args.workdir === undefined) {
      args.workdir = override
      touched = true
    } else if ((input.tool === "glob" || input.tool === "grep") && args.path === undefined) {
      args.path = override
      touched = true
    }
    if (touched) v2Log({ event: "tool.override", tool: input.tool, sessionID: input.sessionID, to: override })
  })

  const shellReg = await ctx.shell.hook("create.before", (input) => {
    const sessionID = (input as { sessionID?: string }).sessionID
    if (!sessionID) return
    const override = deps.overrides.get(sessionID)
    if (!override) return
    input.env.PWD = override
    v2Log({ event: "shell.override", sessionID, to: override })
  })

  v2Log({ event: "setup.done", commands: commands.length })

  return {
    async dispose() {
      await toolReg.dispose()
      await shellReg.dispose()
      await commandReg.dispose()
      v2Log({ event: "setup.disposed" })
    },
  }
}
