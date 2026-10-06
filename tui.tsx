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
import { pickerView } from "./tui.picker.js";

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
    const rawBranch =
      s?.directory === props.api.state.path.directory
        ? (props.api.state.vcs as unknown as Record<string, unknown>)?.branch
        : undefined;
    const branch = typeof rawBranch === "string" && rawBranch.length > 0 ? rawBranch : undefined;
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
    pickerView(api);
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

export function DirectoryView(props: { context: Record<string, never>; sessionID: string }) {
  const context = props.context;
  const home = (process.env.HOME || "") as string;
  const session = createMemo(() => context.data.session.get(props.sessionID));
  const locationDefault = () => context.data.location.default();
  const pathInfo = createMemo(() => {
    const info = session();
    const dir =
      (info?.location?.directory as string) ||
      (locationDefault()?.directory as string) ||
      "?";
    const branch =
      dir === locationDefault()?.directory
        ? context.data.location.vcs.info()?.branch?.current
        : undefined;
    const text = abbreviateHome(dir, home) + (branch ? ":" + branch : "");
    const parts = text.split("/");
    return { parent: parts.slice(0, -1).join("/"), name: parts.at(-1) ?? "" };
  });
  const grants = createMemo(() => {
    const info = session();
    const perms = ((info?.permissions ?? info?.permission ?? []) as Array<
      Record<string, string>
    >);
    const primary =
      (info?.location?.directory as string) || (locationDefault()?.directory as string);
    const registry = (() => {
      try {
        const base =
          process.env.XDG_DATA_HOME ||
          (process.env.HOME || "") + "/.local/share";
        const raw = fs.readFileSync(
          base + "/opencode/opencode-dir/vaults.json",
          "utf-8",
        ) as string;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    })();
    return perms
      .filter(
        (p) => (p.permission ?? p.action) === "external_directory",
      )
      .map((p) => (p.pattern ?? p.resource ?? "").replace(/\/\*$/, ""))
      .filter((d) => d && d !== primary)
      .map((d) =>
        abbreviateHome(registry[d] ? String(registry[d]) : d, home),
      );
  });
  const vaults = createMemo(() => grants().filter((d) => d.includes("vault-")));
  const extras = createMemo(() => grants().filter((d) => !d.includes("vault-")));
  const muted = () => context.theme.text.muted;
  const base = () => context.theme.text.base;
  return (
    <box gap={1}>
      <Show when={vaults().length > 0}>
        <text fg={muted()}>🔓 {vaults().join(", ")}</text>
      </Show>
      <Show when={extras().length > 0}>
        <text fg={muted()}>
          +{String(extras().length)} add-dir: {extras().join(", ")}
        </text>
      </Show>
      <text>
        <span style={{ fg: muted() }}>{pathInfo().parent}/</span>
        <span style={{ fg: base() }}>{pathInfo().name}</span>
      </text>
    </box>
  );
}

const V2Setup = async (context: Record<string, never>) => {
  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      (
        context as unknown as {
          ui: { slot: (claim: Record<string, unknown>) => () => void }
        }
      ).ui.slot({
        append: "sidebar.footer",
        render: (props: Record<string, never>) => (
          <DirectoryView context={context} sessionID={props.sessionID} />
        ),
      }),
    );
  } catch (e) {
    void e;
  }
  const data = (context as unknown as { data?: { listen?: (handler: (event: unknown) => void) => () => void } }).data;
  if (typeof data?.listen === "function") {
    try {
      disposers.push(
        data.listen((event: unknown) => {
          const details = (event as { details?: { type?: string; data?: unknown } } | undefined)?.details;
          if (!details || details.type !== "rpc.opencode-dir.toast") return;
          const payload = (details.data ?? {}) as {
            title?: string;
            message?: string;
            variant?: string;
            duration?: number;
          };
          if (!payload.message) return;
          (
            context as unknown as {
              ui: { toast: { show: (input: Record<string, unknown>) => void } }
            }
          ).ui.toast.show({
            title: payload.title,
            message: payload.message,
            variant: payload.variant,
            duration: payload.duration,
          });
        }),
      );
    } catch (e) {
      void e;
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
  };
};

const plugin: TuiPluginModule & { id: string } & { setup?: unknown } = {
  id: "opencode-dir",
  tui,
  setup: V2Setup,
} as unknown as TuiPluginModule

export default plugin
