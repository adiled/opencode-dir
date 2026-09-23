/** @jsxImportSource @opentui/solid */

import type {
  TuiPromptRef,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Directory picker for directory commands (/cd, /mv, /add-dir, /remove-dir).
 *
 * - Typing `/cd <space>` (or any dir command + trailing space) opens the
 *   picker automatically.
 * - Pressing tab mid-path (e.g. `/cd Doc<tab>`) or ctrl+o / alt+o opens it
 *   on demand.
 * - The partial opens the picker at its deepest existing directory
 *   ("/cd /Users/adil/op" -> browses /Users/adil; missing "Doc" -> cwd).
 * - Picked paths are written back to the prompt, relative when under the
 *   cwd, absolute otherwise. No recommendations.
 *
 * Logs through api.client.app.log (same /log stream as index.ts).
 */

const CMD_RE = /^\/(cd|mv|add-dir|remove-dir)(?:\s+(.*))?\s*$/;
const TARGET_CMDS = ["cd", "mv", "add-dir", "remove-dir"];

let promptRef: TuiPromptRef | undefined;

function pickLog(api: TuiPluginApi, message: string, extra?: Record<string, unknown>) {
  try {
    void (api.client.app.log({
      service: "opencode-dir",
      level: "info",
      message: `[tui.picker] ${message}`,
      extra,
    }) as unknown as Promise<unknown>).catch(() => {});
  } catch {}
}

function truncate(input: string, max = 120): string {
  return input.length > max ? `${input.slice(0, max)}…` : input;
}

/** Wrap a host ref-bind so the plugin captures the prompt instance too. */
function forwardRef(api: TuiPluginApi, bind?: (r: TuiPromptRef | undefined) => void) {
  return (r: TuiPromptRef | undefined) => {
    if (r) promptRef = r;
    bind?.(r);
  };
}

function sessionDir(api: TuiPluginApi): string {
  try {
    const cur = api.route.current as unknown as {
      params?: { sessionID?: string };
    };
    const sid = cur?.params?.sessionID;
    if (sid) {
      const dir = api.state.session.get(sid)?.directory;
      if (dir) return dir;
    }
  } catch {}
  try {
    const p = api.state.path.directory;
    if (p) return p;
  } catch {}
  return process.cwd();
}

/**
 * Deepest existing directory along a partial path — the browse root.
 * e.g. "/Users/adil/op" (op missing) -> /Users/adil; "Docum" (missing) ->
 * cwd; an existing path -> itself; "" -> cwd.
 */
function resolveStart(cwd: string, partial: string): string {
  const p = partial.trim();
  try {
    if (p === "") return cwd;
    if (p === "~") return os.homedir();
    const norm = path.normalize(
      p.startsWith("~/")
        ? path.join(os.homedir(), p.slice(2))
        : path.isAbsolute(p)
          ? p
          : path.resolve(cwd, p),
    );
    if (fs.existsSync(norm) && fs.statSync(norm).isDirectory()) return norm;
    let test = norm;
    while (true) {
      const parent = path.dirname(test);
      if (parent === test) return cwd;
      if (fs.existsSync(test) && fs.statSync(test).isDirectory()) return test;
      test = parent;
    }
  } catch {
    return cwd;
  }
}

/** Relative form when under cwd, else absolute. */
function displayPath(cwd: string, resolved: string): string {
  const rel = path.relative(cwd, resolved);
  if (rel === "") return ".";
  if (!rel.startsWith(".." + path.sep) && rel !== "..") return rel;
  return resolved;
}

function childDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function isRoot(dir: string): boolean {
  return path.dirname(dir) === dir;
}

type Opt = { kind: "pick" } | { kind: "up" } | { kind: "dir"; name: string };

function openPicker(api: TuiPluginApi): void {
  const ref = promptRef;
  const keymapMode = (() => {
    try {
      return api.mode.current();
    } catch {
      return "<err>";
    }
  })();
  const dialogOpen = (() => {
    try {
      return api.ui.dialog.open;
    } catch {
      return "<err>";
    }
  })();

  try {
    if (!ref) {
      pickLog(api, "openPicker: gate FAILED — no prompt ref");
      return;
    }
    if (keymapMode !== "base" && keymapMode !== "autocomplete") {
      pickLog(api, "openPicker: gate FAILED — mode", { keymapMode });
      return;
    }
    if (dialogOpen === true) {
      pickLog(api, "openPicker: gate FAILED — dialog open");
      return;
    }
    if (!ref.focused) {
      pickLog(api, "openPicker: gate FAILED — not focused");
      return;
    }
    if (!ref.current) {
      pickLog(api, "openPicker: gate FAILED — no current prompt info");
      return;
    }
    if (ref.current.mode === "shell") {
      pickLog(api, "openPicker: gate FAILED — shell mode");
      return;
    }
    const input = ref.current.input ?? "";
    const m = input.match(CMD_RE);
    if (!m) {
      pickLog(api, "openPicker: gate FAILED — input not a directory command", {
        input: truncate(input),
      });
      return; // no-op outside directory commands
    }
    const cmd = m[1] as string;
    const partial = m[2] ?? "";
    pickLog(api, "openPicker: gate PASSED — opening browser", {
      cmd,
      partial,
      keymapMode,
      dialogOpen,
      focused: ref.focused,
      input: truncate(input),
    });
    browse(api, cmd, partial);
  } catch (e) {
    pickLog(api, "openPicker ERROR", { error: String(e).slice(0, 200) });
  }
}

function browse(api: TuiPluginApi, cmd: string, partial: string): void {
  const cwd = sessionDir(api);
  let current = resolveStart(cwd, partial);
  pickLog(api, "browse start", {
    cmd,
    partial,
    cwd,
    base: current,
    exists: fs.existsSync(current),
  });

  function render(): void {
    const dirs = childDirs(current);

    function pick(rel: string): void {
      const ref = promptRef;
      const input = `/${cmd} ${rel}`;
      if (ref?.current) {
        try {
          ref.set({ ...ref.current, input });
        } catch (e) {
          pickLog(api, "browse: pick ERROR", { rel, error: String(e).slice(0, 80) });
        }
      }
      api.ui.dialog.clear();
      pickLog(api, "browse: picked", { rel, written: input });
      // Focus reclaim after the dialog closes may reset the buffer from the
      // store — re-assert the value on the next tick if it got stomped.
      setTimeout(() => {
        const r2 = promptRef;
        if (r2?.current && r2.current.input !== input) {
          try {
            r2.set({ ...r2.current, input });
            pickLog(api, "browse: pick re-asserted", { final: r2.current.input });
          } catch {}
        }
      }, 50);
    }

    const options = [
      {
        title: "[use this directory]",
        description: displayPath(cwd, current),
        value: { kind: "pick" } as Opt,
        onSelect: () => {
          pick(displayPath(cwd, current));
        },
      },
      ...(isRoot(current)
        ? []
        : [
            {
              title: ".. (parent)",
              description: path.dirname(current),
              value: { kind: "up" } as Opt,
              onSelect: () => {
                current = path.dirname(current);
                render();
              },
            },
          ]),
      ...dirs.map((name) => ({
        title: `${name}/`,
        value: { kind: "dir", name } as Opt,
        onSelect: () => {
          current = path.join(current, name);
          render();
        },
      })),
    ];

    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={`Pick directory: ${displayPath(cwd, current)}`}
        options={options}
        placeholder="type to filter"
      />
    ));
  }

  render();
}

export function pickerView(api: TuiPluginApi): void {
  try {
    api.slots.register({
      slots: {
        session_prompt: (_ctx, props) => {
          return (
            <api.ui.Prompt
              sessionID={props.session_id}
              visible={props.visible}
              disabled={props.disabled}
              onSubmit={props.on_submit}
              ref={forwardRef(api, props.ref)}
              right={
                <api.ui.Slot
                  name="session_prompt_right"
                  session_id={props.session_id}
                />
              }
            />
          );
        },
        home_prompt: (_ctx, props) => {
          return <api.ui.Prompt ref={forwardRef(api, props.ref)} />;
        },
      },
    });

    api.keymap.registerLayer({
      commands: [
        {
          name: "opencode-dir.pick-dir",
          title: "Pick directory",
          category: "opencode-dir",
          hidden: true,
          run() {
            openPicker(api);
          },
        },
      ],
      bindings: [
        {
          key: "tab",
          desc: "Pick directory",
          group: "opencode-dir",
          cmd: "opencode-dir.pick-dir",
        },
        {
          key: "ctrl+o",
          desc: "Pick directory",
          group: "opencode-dir",
          cmd: "opencode-dir.pick-dir",
        },
        {
          key: "alt+o",
          desc: "Pick directory (alt)",
          group: "opencode-dir",
          cmd: "opencode-dir.pick-dir",
        },
      ],
    });
    // 1.18.32 resolves binding `cmd` through the *command palette*
    // registry (legacy `api.command`), not the layer-local command list —
    // so mirror the command into the palette path with a matching name.
    const legacy = api.command;
    if (legacy) {
      legacy.register(() => [
        {
          title: "Pick directory",
          value: "opencode-dir.pick-dir",
          category: "opencode-dir",
          hidden: true,
          onSelect: () => openPicker(api),
        },
      ]);
    }

    // Space-trigger: the natural `/cd <space>` flow. Poll the prompt input
    // (the ref is not observable) — when the text becomes a directory command
    // with a trailing space, open the picker. No keys are stolen, so typing
    // and cursor position stay untouched; openPicker still gates everything.
    let lastSeen = "";
    let lastFired = "";
    const watcher = setInterval(() => {
      try {
        const r = promptRef;
        const input = r?.current?.input ?? "";
        if (input === lastSeen) return;
        const prev = lastSeen;
        lastSeen = input;
        if (!/^\/(cd|mv|add-dir|remove-dir)\b.*\s+$/.test(input)) return;
        if (input === lastFired) return;
        if (!r?.current || !r.focused) return;
        // Only the typing flow triggers the picker: exactly one trailing
        // space was appended. Backspace towards a previous space (e.g. Esc
        // then back from "/cd  " to "/cd ") must NOT re-open the dialog.
        if (input.length !== prev.length + 1 || !input.endsWith(" ")) return;
        lastFired = input;
        openPicker(api);
      } catch {}
    }, 150);
    api.lifecycle.onDispose(() => clearInterval(watcher));

    pickLog(api, "pickerView installed", {
      triggers: "space-after-command, tab, ctrl+o, alt+o",
      commands: TARGET_CMDS,
      paletteMirrored: Boolean(legacy),
    });
  } catch (e) {
    pickLog(api, "pickerView ERROR", { error: String(e).slice(0, 200) });
  }
}