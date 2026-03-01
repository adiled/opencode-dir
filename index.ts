import { type Plugin } from "@opencode-ai/plugin"
import { mkdirSync, appendFileSync } from "fs"
import {
  type Override,
  type ExecResult,
  loadOverrides,
  persistOverrides,
  execMove,
  rewritePath,
  PATH_TOOLS,
} from "./lib"

const STATE_DIR = `${process.env.XDG_DATA_HOME || process.env.HOME + "/.local/share"}/opencode`
const LOG_FILE = `${STATE_DIR}/opencode-dir-debug.log`
const OVERRIDES_FILE = `${STATE_DIR}/opencode-dir-overrides.json`
const DEBUG = !!process.env.OPENCODE_DIR_DEBUG

function log(...args: unknown[]) {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
  appendFileSync(LOG_FILE, `[${ts}] ${line}\n`)
}

const dirOverrides: Map<string, Override> = loadOverrides(OVERRIDES_FILE)

/**
 * opencode-dir plugin — adds `/cd` and `/mv` commands for moving sessions
 * between directories at runtime.
 *
 * `/cd <path>` changes where tools operate without touching message history.
 * `/mv <path>` does the same and rewrites historical paths in messages.
 */
export const OpencodeDir: Plugin = async ({ client }) => {
  mkdirSync(STATE_DIR, { recursive: true })
  log("plugin loaded", { overridesRecovered: dirOverrides.size })

  return {
    "command.execute.before": async (input, output) => {
      log("command.execute.before", { command: input.command, sessionID: input.sessionID })
      if (input.command !== "cd" && input.command !== "mv") return

      const targetPath = input.arguments.trim()
      if (!targetPath) {
        output.parts.splice(0)
        output.parts.push({ type: "text", text: `Usage: /${input.command} <path>` })
        return
      }

      let exec: ExecResult
      try {
        exec = execMove(input.sessionID, targetPath, input.command === "mv")
      } catch (e: unknown) {
        exec = { result: `Error: ${e instanceof Error ? e.message : String(e)}` }
      }

      output.parts.splice(0)
      output.parts.push({ type: "text", text: exec.result })

      if (exec.oldDir && exec.newDir) {
        log("storing override", { sessionID: input.sessionID, oldDir: exec.oldDir, newDir: exec.newDir })
        dirOverrides.set(input.sessionID, { oldDir: exec.oldDir, newDir: exec.newDir })
        persistOverrides(OVERRIDES_FILE, dirOverrides)

        await client.tui.showToast({
          body: {
            title: "Session directory changed",
            message: `Now operating in ${exec.newDir}.\nRestart opencode there for a clean slate.`,
            variant: "info",
            duration: 8000,
          },
        }).catch(() => {})
      }
    },

    "tool.execute.before": async (input, output) => {
      const override = dirOverrides.get(input.sessionID)
      if (!override) return
      log("tool.execute.before", { tool: input.tool, sessionID: input.sessionID })

      const { oldDir, newDir } = override
      const pathKeys = PATH_TOOLS[input.tool]
      if (pathKeys) {
        for (const key of pathKeys) {
          if (typeof output.args[key] === "string") {
            output.args[key] = rewritePath(output.args[key], oldDir, newDir)
          }
        }
      }

      if (input.tool === "bash") {
        if (!output.args.workdir) output.args.workdir = newDir
        if (typeof output.args.command === "string") {
          output.args.command = output.args.command.replaceAll(oldDir, newDir)
        }
      }
    },

    "shell.env": async (input, output) => {
      const override = dirOverrides.get(input.sessionID ?? "")
      if (!override) return

      const { oldDir, newDir } = override
      if (input.cwd === oldDir || input.cwd.startsWith(oldDir + "/")) {
        output.env.PWD = rewritePath(input.cwd, oldDir, newDir)
      }
    },
  }
}
