import { appendFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { dirname, resolve } from "path"

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
  const line = serializeV2Log(fields)
  const path = ensureLogDir()
  if (path) {
    try {
      appendFileSync(path, line + "\n")
    } catch {}
  }
  try {
    console.log(`[${SERVICE}] ${line}`)
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

export interface V2Deps {
  resolveDir: (raw: string) => { dir: string }
  overrides: Map<string, string>
  persistOverrides: (map: Map<string, string>) => void
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
    let current = ""
    try {
      current = (await ctx.session.get({ sessionID })).location.directory
    } catch (e) {
      v2Log({ event: "session.get.failed", command, sessionID, result: String(e) })
    }

    try {
      await ctx.session.move({ sessionID, directory: dir, delivery: invocation.delivery })
    } catch (e) {
      const result = e instanceof Error ? e.message : String(e)
      v2Log({ event: "session.move.failed", command, sessionID, from: current, to: dir, result })
      return { status: "error", result: `Could not move session: ${result}` }
    }

    v2Log({ event: "session.move.ok", command, sessionID, from: current, to: dir })

    if (current && current !== dir) {
      deps.overrides.set(sessionID, dir)
      deps.persistOverrides(deps.overrides)
      v2Log({ event: "override.set", sessionID, from: current, to: dir, count: deps.overrides.size })
    }

    return { status: "ok", result: `working directory is now ${dir}` }
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
      const text =
        outcome.status === "error" ? `opencode-dir: ${outcome.result}` : `opencode-dir: ${outcome.result}`
      v2Log({ event: "command.surface", command: name, sessionID: invocation.sessionID, outcome })
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
