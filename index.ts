import { type Plugin, type PluginModule } from "@opencode-ai/plugin"
import { mkdirSync, appendFileSync } from "fs"
import {
  type Override,
  type ExecResult,
  installCommands,
  loadOverrides,
  persistOverrides,
  execMove,
  execAddDir,
  reportError,
  getOpencodeVersion,
  meetsMinVersion,
  MIN_OPENCODE_VERSION,
  checkForUpdate,
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

// ── Commands ────────────────────────────────────────────────────────────────

// /cd  — change session directory (no message rewrite)
// /mv  — move session directory AND rewrite message paths
// /add-dir — grant tool access to an additional directory

export const OpencodeDir: Plugin = async ({ client }) => {
  mkdirSync(STATE_DIR, { recursive: true })
  installCommands()
  log("plugin loaded", { overridesRecovered: dirOverrides.size })

  const ocVersion = getOpencodeVersion()
  log("opencode version", { version: ocVersion, minimum: MIN_OPENCODE_VERSION })
  if (ocVersion && !meetsMinVersion(ocVersion, MIN_OPENCODE_VERSION)) {
    await client.tui.showToast({
      body: {
        title: "opencode-dir: update required",
        message: `opencode ${MIN_OPENCODE_VERSION}+ is required, you have ${ocVersion}. Some features may not work.`,
        variant: "warning",
        duration: 10000,
      },
    }).catch(() => {})
  }

  // Non-blocking self-update check — purges cache if newer version exists
  checkForUpdate().then((result) => {
    log("update check", result)
    if (result.updated) {
      client.tui.showToast({
        body: {
          title: "opencode-dir: update available",
          message: `v${result.to} is available (you have v${result.from}). Restart opencode to apply.`,
          variant: "info",
          duration: 12000,
        },
      }).catch(() => {})
    }
  }).catch(() => {})

  return {
    "command.execute.before": async (input, output) => {
      log("command.execute.before", { command: input.command, sessionID: input.sessionID })
      if (input.command !== "cd" && input.command !== "mv" && input.command !== "add-dir") return

      const targetPath = input.arguments.trim()
      if (!targetPath) {
        output.parts.splice(0)
        output.parts.push({ type: "text", text: `Usage: /${input.command} <path>` })
        return
      }

      if (input.command === "add-dir") {
        let exec: ExecResult
        try {
          exec = execAddDir(input.sessionID, targetPath)
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e))
          reportError(err)
          exec = { result: `Error: ${err.message}` }
        }

        output.parts.splice(0)
        output.parts.push({ type: "text", text: exec.result })

        if (!exec.result.startsWith("Error") && !exec.result.includes("already accessible")) {
          await client.tui.showToast({
            body: {
              title: "Directory added",
              message: `Tools can now access files under the added directory.`,
              variant: "info",
              duration: 5000,
            },
          }).catch(() => {})
        }
        return
      }

      let exec: ExecResult
      try {
        exec = execMove(input.sessionID, targetPath, input.command === "mv")
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e))
        reportError(err)
        exec = { result: `Error: ${err.message}` }
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
            message: `Now operating in ${exec.newDir}.\nThis session will list under the new project on next launch.`,
            variant: "info",
            duration: 8000,
          },
        }).catch(() => {})
      }
    },

    "tool.execute.before": async (input, output) => {
      try {
        const override = dirOverrides.get(input.sessionID)
        if (!override) return
        log("tool.execute.before", { tool: input.tool, sessionID: input.sessionID })

        const { newDir } = override

        // Inject newDir as default path for tools that fall back to Instance.directory
        if (input.tool === "bash") {
          if (!output.args.workdir) output.args.workdir = newDir
        } else if (input.tool === "glob" || input.tool === "grep") {
          if (!output.args.path) output.args.path = newDir
        }
      } catch (e) {
        if (e instanceof Error) reportError(e)
      }
    },

    "shell.env": async (input, output) => {
      try {
        const override = dirOverrides.get(input.sessionID ?? "")
        if (!override) return

        output.env.PWD = override.newDir
      } catch (e) {
        if (e instanceof Error) reportError(e)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        const override = dirOverrides.get(input.sessionID ?? "")
        if (!override) return

        output.system[0] = output.system[0].replace(
          /Working directory: .*/,
          `Working directory: ${override.newDir}`,
        )
      } catch (e) {
        if (e instanceof Error) reportError(e)
      }
    },
  }
}

export default {
  id: "opencode-dir",
  server: OpencodeDir,
} satisfies PluginModule