import { type Plugin } from "@opencode-ai/plugin"
import { mkdirSync, appendFileSync } from "fs"
import {
  type Override,
  type ExecResult,
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

const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir()
const STATE_DIR = `${process.env.XDG_DATA_HOME || home + "/.local/share"}/opencode`
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
    config: async (input) => {
      input.command ??= {}
      input.command.cd = {
        description: "Change session working directory",
        template: "Change the session's working directory to $ARGUMENTS. Tools will operate in the new directory immediately. Message history is left untouched.",
      }
      input.command.mv = {
        description: "Move session and rewrite paths",
        template: "Move the session to $ARGUMENTS and rewrite path.cwd/root in all message history. Use when you want full context to reflect the new location.",
      }
      input.command["add-dir"] = {
        description: "Grant tool access to an additional directory",
        template: "Grant tool access to $ARGUMENTS without changing the session's working directory. Use when you need to read or write files in a secondary project or monorepo package.",
      }
    },

    "command.execute.before": async (input, output) => {
      log("command.execute.before", { command: input.command, sessionID: input.sessionID })
      if (input.command !== "cd" && input.command !== "mv" && input.command !== "add-dir") return

      const targetPath = input.arguments.trim()
      if (!targetPath) {
        await client.tui.showToast({
          body: {
            title: "Usage",
            message: `/${input.command} <path>`,
            variant: "info",
            duration: 5000,
          },
        }).catch(() => {})
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

        if (exec.result.startsWith("Error")) {
          await client.tui.showToast({
            body: {
              title: "Error",
              message: exec.result,
              variant: "error",
              duration: 8000,
            },
          }).catch(() => {})
        } else if (exec.result.includes("already accessible")) {
          await client.tui.showToast({
            body: {
              title: "Already accessible",
              message: exec.result,
              variant: "info",
              duration: 5000,
            },
          }).catch(() => {})
        } else {
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

      if (exec.result.startsWith("Error")) {
        await client.tui.showToast({
          body: {
            title: "Error",
            message: exec.result,
            variant: "error",
            duration: 8000,
          },
        }).catch(() => {})
        return
      }

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
      } else if (exec.result.includes("Already in")) {
        await client.tui.showToast({
          body: {
            title: "No change needed",
            message: exec.result,
            variant: "info",
            duration: 5000,
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
}