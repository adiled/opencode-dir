/** @jsxImportSource @opentui/solid */

// @ts-nocheck
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import { createMemo, Show } from "solid-js";
import * as path from "node:path";
import * as fs from "node:fs";
import { Effect } from "effect";

function abbreviateHome(input: string, home: string) {
  if (!home) return input;
  const relative = path.relative(home, input);
  if (relative === "") return "~";
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    return input;
  return "~" + path.sep + relative;
}

export function View(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current;
  const home = (process.env.HOME || "") as string;
  const pathInfo = createMemo(() => {
    const s = props.api.state.session.get(props.sessionID) as unknown as Record<string, unknown>;
    const dir = (s?.directory as string) || props.api.state.path.directory || "?";
    const out = abbreviateHome(dir, home);
    const branch =
      s?.directory === props.api.state.path.directory
        ? (props.api.state.vcs as unknown as Record<string, unknown>)?.branch
        : undefined;
    const text = branch ? out + ":" + branch : out;
    const parts = text.split("/");
    return {
      parent: parts.slice(0, -1).join("/"),
      name: parts.at(-1) ?? "",
      dir,
    };
  });
  const vaults = createMemo(() => {
    const s = props.api.state.session.get(props.sessionID) as unknown as Record<string, unknown>;
    const perms = (s?.permission ?? s?.permissions ?? []) as Array<{ permission?: string; action?: string; pattern?: string; resource?: string }>;
    let reg: Record<string, string> = {};
    try {
      reg = JSON.parse(fs.readFileSync(
        (process.env.XDG_DATA_HOME || process.env.HOME + "/.local/share") + "/opencode/opencode-dir/vaults.json",
        "utf-8",
      ) as string);
    } catch {}
    return perms
      .filter(
        (p) =>
          p?.permission === "external_directory" ||
          p?.action === "external_directory",
      )
      .map((p) => (p.pattern ?? p.resource ?? "") as string)
      .map((d: string) => d.replace(/\/\*$/, ""))
      .filter((d: string) => d.includes("vault-"))
      .map((d: string) =>
        reg[d] ? abbreviateHome(reg[d], home) : abbreviateHome(d, home),
      );
  });
  const extras = createMemo(() => {
    const s = props.api.state.session.get(props.sessionID) as unknown as Record<string, unknown>;
    const perms = (s?.permission ?? s?.permissions ?? []) as Array<{ permission?: string; action?: string; pattern?: string; resource?: string }>;
    const primary = pathInfo().dir;
    const list = perms
      .filter(
        (p) =>
          p?.permission === "external_directory" ||
          p?.action === "external_directory",
      )
      .map((p) => (p.pattern ?? p.resource ?? "") as string)
      .map((d: string) => d.replace(/\/\*$/, ""))
      .filter((d: string) => d && d !== primary && !d.includes("vault-"))
      .map((d: string) => abbreviateHome(d, home));
    return list;
  });
  return (
    <box gap={1}>
      <Show when={vaults().length > 0}>
        <text fg={theme().textMuted}>🔓 {vaults().join(", ")}</text>
      </Show>
      <Show when={extras().length > 0}>
        <text fg={theme().textMuted}>
          +{String(extras().length)} add-dir: {extras().join(", ")}
        </text>
      </Show>
      <text>
        <span style={{ fg: theme().textMuted }}>{pathInfo().parent}/</span>
        <span style={{ fg: theme().text }}>{pathInfo().name}</span>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Open</b>
        <span style={{ fg: theme().text }}>
          <b>Code</b>
        </span>{" "}
        {` ${props.api.app.version}`}
      </text>
    </box>
  );
}

export const tui: TuiPlugin = async (api) => {
  try {
    const home = (process.env.HOME || "") as string;
    const base = (process.env.XDG_DATA_HOME ||
      home + "/.local/share") as string;
    setInterval(() => {
      try {
        const cur = (api.route.current as unknown as { params?: { sessionID?: string } })?.params?.sessionID as
          string | undefined;
        if (!cur) return;
        const need = `${base}/opencode/opencode-dir/vault-need-${cur}`;
        if (!fs.existsSync(need)) return;
        fs.rmSync(need, { force: true });
        api.ui.dialog.replace(() => (
          <api.ui.DialogPrompt
            title="Vault passphrase"
            placeholder="enter passphrase"
            onConfirm={(val: string) => {
              try {
                const isInitGlobal =
                  fs.existsSync(
                    `${base}/opencode/opencode-dir/vault-need-${cur}`,
                  ) &&
                  (
                    fs.readFileSync(
                      `${base}/opencode/opencode-dir/vault-need-${cur}`,
                      "utf-8",
                    ) as string
                  ).trim() === "init";
                const key = isInitGlobal
                  ? "opencode-dir-vault-global"
                  : `opencode-dir-vault-${cur}`;
                const { execSync } = require("child_process");
                if (process.platform === "darwin") {
                  const existed = (() => {
                    try {
                      execSync(
                        `security find-generic-password -s "${key}" -w 2>/dev/null`,
                      );
                      return true;
                    } catch {
                      return false;
                    }
                  })();
                  execSync(
                    `security delete-generic-password -s "${key}" 2>/dev/null || true`,
                  );
                  execSync(
                    `security add-generic-password -s "${key}" -a "${process.env.USER}" -w "${val.replace(/"/g, '\\"')}"`,
                  );
                  api.ui.toast({
                    message: existed ? "Passphrase updated" : "Passphrase set",
                  });
                } else {
                  execSync(
                    `printf "%s" "${val.replace(/"/g, '\\"')}" | secret-tool store --label="opencode-dir ${key}" opencode-dir ${key}`,
                  );
                  api.ui.toast({ message: "Passphrase set" });
                }
              } catch (e) {
                api.ui.toast({
                  message: `Keychain failed: ${String(e).slice(0, 80)}`,
                });
              }
              api.ui.dialog.clear();
            }}
            onCancel={() => api.ui.dialog.clear()}
          />
        ));
      } catch {}
    }, 1000);
    (api as unknown as { keymap?: { registerLayer?: (layer: unknown) => void } }).keymap?.registerLayer?.({
      commands: [
        {
          title: "Vault: set passphrase",
          value: "opencode-dir.vault.pass",
          description: "Set vault passphrase for this session",
        },
      ],
      bindings: [
        { command: "opencode-dir.vault.pass", keys: "ctrl+shift+v" },
      ],
      handler: async (cmd: string) => {
        if (cmd !== "opencode-dir.vault.pass") return false;
        const cur = (api.route.current as unknown as { params?: { sessionID?: string } })?.params?.sessionID as
          string | undefined;
        const sid = cur || (api.state as unknown as { session?: { get?: (...args: unknown[]) => unknown } }).session?.get ? "" : "";
        await new Promise<void>((resolve) => {
          api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
              title="Vault passphrase"
              placeholder="enter passphrase"
              onConfirm={(val: string) => {
                try {
                  const home = (process.env.HOME || "") as string;
                  const base = (process.env.XDG_DATA_HOME ||
                    home + "/.local/share") as string;
                  const file = `${base}/opencode/opencode-dir/vault-pass-${cur || sid}`;
                  if (cur || sid) {
                    fs.mkdirSync(path.dirname(file), {
                      recursive: true,
                    });
                    fs.writeFileSync(file, val, {
                      mode: 0o600,
                    });
                    api.ui.toast?.({
                      message: "Vault passphrase set",
                    });
                  }
                } catch {}
                api.ui.dialog.clear();
                resolve();
              }}
              onCancel={() => {
                api.ui.dialog.clear();
                resolve();
              }}
            />
          ));
        });
        return true;
      },
    });
  } catch {}
  api.slots.register({
    id: "opencode-dir-footer",
    order: 50,
    slots: {
      sidebar_footer(_ctx, props) {
        try {
          return <View api={api} sessionID={props.session_id} />;
        } catch (e) {
          return (
            <box>
              <text fg={api.theme.current.error}>
                ERR footer {String(e).slice(0, 60)}
              </text>
            </box>
          ) as unknown as unknown;
        }
      },
    },
  });
};

const V2TuiEffect = (_ctx: any) => Effect.void
const plugin: TuiPluginModule & { id: string } & { effect?: any; setup?: any } = {
  id: "opencode-dir",
  tui,
  effect: V2TuiEffect,
  setup: V2TuiEffect,
} as any

export default plugin
