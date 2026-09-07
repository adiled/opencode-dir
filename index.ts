import { type Plugin } from "@opencode-ai/plugin";
import type { Plugin as PromisePlugin } from "@opencode-ai/plugin/v2/promise";
import { commands } from "./lib.protocol";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { Effect } from "effect";
import {
  type Override,
  type ExecResult,
  loadOverrides,
  persistOverrides,
  execMove,
  execAddDir,
  execRemoveDir,
  reportError,
  reportUpdateError,
  getVersion,
  getOpencodeVersion,
  meetsMinVersion,
  MIN_OPENCODE_VERSION,
  checkForUpdate,
  initPluginGuard,
  getSessionPermissions,
  getSessionInfo,
  getDbPath,
} from "./lib";
import { vaultInit, vaultOpen, vaultClose } from "./lib.vault";
import { Database } from "./db";

const home = process.env.HOME || process.env.USERPROFILE || homedir();
const STATE_DIR = `${process.env.XDG_DATA_HOME || home + "/.local/share"}/opencode`;
const OVERRIDES_FILE = `${STATE_DIR}/opencode-dir-overrides.json`;

const dirOverrides: Map<string, Override> = loadOverrides(OVERRIDES_FILE);

// ── Commands ────────────────────────────────────────────────────────────────

// /cd  — change session directory (no message rewrite)
// /mv  — move session directory AND rewrite message paths
// /add-dir — grant tool access to an additional directory

export const OpencodeDir: Plugin = async ({ client }) => {
  initPluginGuard();
  mkdirSync(STATE_DIR, { recursive: true });
  Effect.runSync(
    Effect.logInfo("opencode-dir plugin loaded", {
      overridesRecovered: dirOverrides.size,
    }),
  );

  const ocVersion = getOpencodeVersion();
  Effect.runSync(
    Effect.logInfo("opencode version", {
      version: ocVersion,
      minimum: MIN_OPENCODE_VERSION,
    }),
  );
  if (ocVersion && !meetsMinVersion(ocVersion, MIN_OPENCODE_VERSION)) {
    await client.tui
      .showToast({
        body: {
          title: "opencode-dir: update required",
          message: `opencode ${MIN_OPENCODE_VERSION}+ is required, you have ${ocVersion}. Some features may not work.`,
          variant: "warning",
          duration: 10000,
        },
      })
      .catch(() => {});
  }

  // Non-blocking self-update check — purges cache if newer version exists
  const updateResult = await checkForUpdate();
  Effect.runSync(Effect.logInfo("opencode-dir update check", updateResult));
  if (updateResult.updated) {
    client.tui
      .showToast({
        body: {
          title: "opencode-dir: update available",
          message: `v${updateResult.to} is available (you have v${updateResult.from}). Restart opencode to apply.`,
          variant: "info",
          duration: 12000,
        },
      })
      .catch(() => {});
  } else if (updateResult.error) {
    // Report detailed error to Sentry for debugging
    reportUpdateError({
      message: `Update check failed`,
      error: new Error(updateResult.error),
      currentVersion: getVersion() ?? "unknown",
      url: "https://registry.npmjs.org/opencode-dir/latest",
    });
    // Suppress toast on error - don't show update available toast on failure
  }

  return {
    config: async (input) => {
      const { commands } = await import("./lib.protocol.js");
      input.command ??= {};
      for (const [name, info] of Object.entries(commands))
        input.command[name] = {
          description: info.description,
          template: info.template,
        };
    },

    "command.execute.before": async (input, output) => {
      Effect.runSync(
        Effect.logInfo("opencode-dir command.execute.before", {
          command: input.command,
          sessionID: input.sessionID,
        }),
      );
      // per-command protocol drift check
      try {
        const { registry, runWithDriftCheck } =
          await import("./lib.protocol.js");
        const proto = registry[input.command];
        if (proto) {
          const db = new (await import("./db.js")).Database(
            (await import("./lib.js")).getDbPath(),
          );
          try {
            await runWithDriftCheck(
              db,
              proto,
              async (msg) => {
                await client.tui
                  .showToast({
                    body: {
                      title: "Heads up",
                      message: msg,
                      variant: "info",
                      duration: 6000,
                    },
                  })
                  .catch(() => {});
              },
              () => {},
            );
          } finally {
            db.close();
          }
        }
      } catch {}
      if (input.command === "vault") {
        const raw = input.arguments.trim();
        const [sub, ...rest] = raw.split(/\s+/);
        const target = rest.join(" ").trim();
        const { getVaultPass, needVaultPassFile } =
          await import("./lib.vault.js");
        // /vault init with no dir = set/change passphrase (even if env set)
        if (sub === "init" && !target) {
          try {
            const { writeFileSync, mkdirSync } = await import("fs");
            const { dirname } = await import("path");
            const f = needVaultPassFile(input.sessionID);
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, "init");
          } catch {}
          output.parts = [
            {
              type: "text",
              id: "prt_" + Date.now(),
              sessionID: input.sessionID,
              messageID: "msg_" + Date.now(),
              text: "Vault init — enter passphrase in dialog.",
            },
          ];
          await client.tui
            .showToast({
              body: {
                title: "Vault passphrase",
                message: "Enter new passphrase",
                variant: "info",
                duration: 6000,
              },
            })
            .catch(() => {});
          return;
        }
        let pass = getVaultPass(input.sessionID);
        if (!pass) {
          output.parts = [
            {
              type: "text",
              id: "prt_" + Date.now(),
              sessionID: input.sessionID,
              messageID: "msg_" + Date.now(),
              text: `Vault ${sub} failed: no passphrase set. Run /vault init to set one or set OPENCODE_DIR_VAULT_PASS.`,
            },
          ];
          await client.tui
            .showToast({
              body: {
                title: "Vault failed",
                message: "No passphrase — run /vault init",
                variant: "error",
                duration: 8000,
              },
            })
            .catch(() => {});
          return;
        }
        // prompt for passphrase via tui if not env
        if (!target && sub !== "list") {
          await client.tui
            .showToast({
              body: {
                title: "Usage",
                message: "/vault init|open|close <dir>",
                variant: "info",
                duration: 5000,
              },
            })
            .catch(() => {});
          return;
        }
        if (sub === "init") {
          const r = vaultInit(target, pass);
          output.parts = [
            {
              type: "text",
              id: "prt_" + Date.now(),
              sessionID: input.sessionID,
              messageID: "msg_" + Date.now(),
              text: r.ok
                ? `Vault init: ${target} encrypted`
                : `Error: ${r.error}`,
            },
          ];
          await client.tui
            .showToast({
              body: {
                title: r.ok ? "Vault init" : "Error",
                message: r.ok ? `${target} encrypted` : r.error!,
                variant: r.ok ? "info" : "error",
                duration: 5000,
              },
            })
            .catch(() => {});
          return;
        }
        if (sub === "open") {
          const db = new Database(getDbPath());
          try {
            const r = vaultOpen(db, input.sessionID, target, pass);
            output.parts = [
              {
                type: "text",
                id: "prt_" + Date.now(),
                sessionID: input.sessionID,
                messageID: "msg_" + Date.now(),
                text: r.ok
                  ? `Vault open: ${r.tmp} (session-scoped)`
                  : `Error: ${r.error}`,
              },
            ];
            await client.tui
              .showToast({
                body: {
                  title: r.ok ? "Vault open" : "Error",
                  message: r.ok ? `Decrypted to ${r.tmp}` : r.error!,
                  variant: r.ok ? "info" : "error",
                  duration: 6000,
                },
              })
              .catch(() => {});
          } finally {
            db.close();
          }
          return;
        }
        if (sub === "close") {
          const db = new Database(getDbPath());
          try {
            const r = vaultClose(db, input.sessionID, target, pass);
            output.parts = [
              {
                type: "text",
                id: "prt_" + Date.now(),
                sessionID: input.sessionID,
                messageID: "msg_" + Date.now(),
                text: r.ok ? `Vault closed: ${target}` : `Error: ${r.error}`,
              },
            ];
            await client.tui
              .showToast({
                body: {
                  title: r.ok ? "Vault closed" : "Error",
                  message: r.ok ? `${target} re-encrypted` : r.error!,
                  variant: r.ok ? "info" : "error",
                  duration: 5000,
                },
              })
              .catch(() => {});
          } finally {
            db.close();
          }
          return;
        }
        return;
      }
      if (
        input.command !== "cd" &&
        input.command !== "mv" &&
        input.command !== "add-dir" &&
        input.command !== "remove-dir"
      )
        return;

      const targetPath = input.arguments.trim();
      if (!targetPath) {
        await client.tui
          .showToast({
            body: {
              title: "Usage",
              message: `/${input.command} <path>`,
              variant: "info",
              duration: 5000,
            },
          })
          .catch(() => {});
        return;
      }

      if (input.command === "add-dir") {
        let exec: ExecResult;
        try {
          exec = execAddDir(input.sessionID, targetPath);
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));
          reportError(err);
          exec = { result: `Error: ${err.message}` };
        }

        if (exec.result.startsWith("Error")) {
          await client.tui
            .showToast({
              body: {
                title: "Error",
                message: exec.result,
                variant: "error",
                duration: 8000,
              },
            })
            .catch(() => {});
        } else if (exec.result.includes("already accessible")) {
          await client.tui
            .showToast({
              body: {
                title: "Already accessible",
                message: exec.result,
                variant: "info",
                duration: 5000,
              },
            })
            .catch(() => {});
          output.parts = [
            {
              type: "text",
              id: "prt_" + Date.now(),
              sessionID: input.sessionID,
              messageID: "msg_" + Date.now(),
              text: `${targetPath} is now an additional working directory with same permissions as primary working directory`,
            },
          ];
        } else {
          await client.tui
            .showToast({
              body: {
                title: "Directory added",
                message: `Tools can now access files under the added directory.`,
                variant: "info",
                duration: 5000,
              },
            })
            .catch(() => {});
          output.parts = [
            {
              type: "text",
              id: "prt_" + Date.now(),
              sessionID: input.sessionID,
              messageID: "msg_" + Date.now(),
              text: `${targetPath} is now an additional working directory with same permissions as primary working directory`,
            },
          ];
        }
        return;
      }

      if (input.command === "remove-dir") {
        let ex: ExecResult;
        try {
          ex = execRemoveDir(input.sessionID, targetPath);
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));
          reportError(err);
          ex = { result: `Error: ${err.message}` };
        }

        if (ex.result.startsWith("Error")) {
          await client.tui
            .showToast({
              body: {
                title: "Error",
                message: ex.result,
                variant: "error",
                duration: 8000,
              },
            })
            .catch(() => {});
          return;
        }

        if (ex.result.includes("not currently granted")) {
          await client.tui
            .showToast({
              body: {
                title: "Not granted",
                message: ex.result,
                variant: "info",
                duration: 5000,
              },
            })
            .catch(() => {});
          output.parts = [
            {
              type: "text",
              id: "prt_" + Date.now(),
              sessionID: input.sessionID,
              messageID: "msg_" + Date.now(),
              text: ex.result,
            },
          ];
        } else {
          await client.tui
            .showToast({
              body: {
                title: "Directory removed",
                message: `Tools can no longer access ${targetPath} in this session.`,
                variant: "info",
                duration: 5000,
              },
            })
            .catch(() => {});
          output.parts = [
            {
              type: "text",
              id: "prt_" + Date.now(),
              sessionID: input.sessionID,
              messageID: "msg_" + Date.now(),
              text: ex.result,
            },
          ];
        }
        return;
      }

      let exec: ExecResult;
      try {
        exec = execMove(input.sessionID, targetPath, input.command === "mv");
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        reportError(err);
        exec = { result: `Error: ${err.message}` };
      }

      if (exec.result.startsWith("Error")) {
        await client.tui
          .showToast({
            body: {
              title: "Error",
              message: exec.result,
              variant: "error",
              duration: 8000,
            },
          })
          .catch(() => {});
        return;
      }

      if (exec.oldDir && exec.newDir) {
        Effect.runSync(
          Effect.logInfo("opencode-dir storing override", {
            sessionID: input.sessionID,
            oldDir: exec.oldDir,
            newDir: exec.newDir,
          }),
        );
        dirOverrides.set(input.sessionID, {
          oldDir: exec.oldDir,
          newDir: exec.newDir,
        });
        persistOverrides(OVERRIDES_FILE, dirOverrides);

        await client.tui
          .showToast({
            body: {
              title: "Session directory changed",
              message: `Now operating in ${exec.newDir}.\nThis session will list under the new project on next launch.`,
              variant: "info",
              duration: 8000,
            },
          })
          .catch(() => {});
        output.parts = [
          {
            type: "text",
            id: "prt_" + Date.now(),
            sessionID: input.sessionID,
            messageID: "msg_" + Date.now(),
            text: `working directory is now ${exec.newDir}`,
          },
        ];
      } else if (exec.result.includes("Already in")) {
        await client.tui
          .showToast({
            body: {
              title: "No change needed",
              message: exec.result,
              variant: "info",
              duration: 5000,
            },
          })
          .catch(() => {});
        output.parts = [
          {
            type: "text",
            id: "prt_" + Date.now(),
            sessionID: input.sessionID,
            messageID: "msg_" + Date.now(),
            text: `working directory is now ${targetPath}`,
          },
        ];
      }
    },

    "tool.execute.before": async (input, output) => {
      try {
        const override = dirOverrides.get(input.sessionID);
        if (!override) return;
        Effect.runSync(
          Effect.logInfo("opencode-dir tool.execute.before", {
            tool: input.tool,
            sessionID: input.sessionID,
          }),
        );

        const { newDir } = override;

        // Inject newDir as default path for tools that fall back to Instance.directory
        if (input.tool === "bash") {
          if (!output.args.workdir) output.args.workdir = newDir;
        } else if (input.tool === "glob" || input.tool === "grep") {
          if (!output.args.path) output.args.path = newDir;
        }
      } catch (e) {
        if (e instanceof Error) reportError(e);
      }
    },

    "shell.env": async (input, output) => {
      try {
        const override = dirOverrides.get(input.sessionID ?? "");
        if (!override) return;

        output.env.PWD = override.newDir;
      } catch (e) {
        if (e instanceof Error) reportError(e);
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        const override = dirOverrides.get(input.sessionID ?? "");
        if (override) {
          output.system[0] = output.system[0].replace(
            /Working directory: .*/,
            `Working directory: ${override.newDir}`,
          );
        }
        // Reflect add-dir: show additional directories from permission (legacy + new table)
        const sid = input.sessionID;
        if (sid) {
          try {
            const db = new Database(getDbPath());
            try {
              const info = getSessionInfo(db, sid);
              const perms = getSessionPermissions(db, sid) as Array<{ permission: string; pattern: string }>;
              const dirs = perms
                .filter((r) => r.permission === "external_directory")
                .map((r) => r.pattern.replace(/\/\*$/, ""));
              // Also include permission table entries for this project
              if (info) {
                try {
                  const rows = db
                    .query(
                      `SELECT resource FROM permission WHERE project_id = ? AND action = 'external_directory'`,
                    )
                    .all(info.projectId) as { resource: string }[];
                  for (const row of rows) {
                    const d = row.resource.replace(/\/\*$/, "");
                    if (!dirs.includes(d)) dirs.push(d);
                  }
                } catch {}
              }
              if (dirs.length) {
                // Remove primary from list (already shown as Working directory)
                const primary = override?.newDir ?? info?.directory;
                const extra = dirs.filter((d) => d !== primary);
                if (extra.length) {
                  output.system[0] += `\nAdditional working directories: ${extra.join(", ")}`;
                }
              }
            } finally {
              db.close();
            }
          } catch {}
        }
      } catch (e) {
        if (e instanceof Error) reportError(e);
      }
    },
  };
};

// V2 (promise variant): host adapts this with its own Effect runtime,
// so no Effect import is used here — avoids cross-copy context crash.
type RuntimeCommandDraft = {
  add: (name: string, info: { template: string; description: string }) => void;
};
const V2Setup: PromisePlugin["setup"] = async (ctx) => {
  await ctx.command.transform((draft) => {
    const runtime = draft as unknown as RuntimeCommandDraft;
    for (const [name, info] of Object.entries(commands)) {
      runtime.add(name, { template: info.template, description: info.description });
    }
  });
  Effect.runSync(Effect.log("opencode-dir V2 commands registered", Object.keys(commands)));
};
export default {
  id: "opencode-dir",
  server: OpencodeDir,
  setup: V2Setup,
};
