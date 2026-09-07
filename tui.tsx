/** @jsxImportSource @opentui/solid */

// @ts-nocheck
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import * as path from "node:path"

function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const relative = path.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return input
  return "~" + path.sep + relative
}

export function View(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const home = (process.env.HOME || "") as string
  const pathInfo = createMemo(() => {
    const s = props.api.state.session.get(props.sessionID) as any
    const dir = s?.directory || props.api.state.path.directory || "?"
    const out = abbreviateHome(dir, home)
    const branch = s?.directory === props.api.state.path.directory ? (props.api.state.vcs as any)?.branch : undefined
    const text = branch ? out + ":" + branch : out
    const parts = text.split("/")
    return { parent: parts.slice(0, -1).join("/"), name: parts.at(-1) ?? "", dir }
  })
  const extras = createMemo(() => {
    const s = props.api.state.session.get(props.sessionID) as any
    const perms: any[] = s?.permission ?? s?.permissions ?? []
    const primary = pathInfo().dir
    const list = perms
      .filter((p: any) => p?.permission === "external_directory" || p?.action === "external_directory")
      .map((p: any) => (p.pattern ?? p.resource ?? "") as string)
      .map((d: string) => d.replace(/\/\*$/, ""))
      .filter((d: string) => d && d !== primary)
      .map((d: string) => abbreviateHome(d, home))
    try { if (list.length) props.api.client.app.log({ body: { service: "opencode-dir-tui", level: "info", message: `extras ${list.join(",")}` } }).catch(()=>{}) } catch {}
    return list
  })
  return (
    <box gap={1}>
      <Show when={extras().length > 0}>
        <text fg={theme().textMuted}>+{String(extras().length)} add-dir: {extras().join(", ")}</text>
      </Show>
      <text>
        <span style={{ fg: theme().textMuted }}>{pathInfo().parent}/</span>
        <span style={{ fg: theme().text }}>{pathInfo().name}</span>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Open</b>
        <span style={{ fg: theme().text }}><b>Code</b></span> {` ${props.api.app.version}`}
      </text>
    </box>
  )
}

export const tui: TuiPlugin = async (api) => {
  try { await api.client.app.log({ body: { service: "opencode-dir-tui", level: "info", message: `tui load id=opencode-dir ver=${api.app.version}` } }) } catch {}
  api.slots.register({
    id: "opencode-dir-footer",
    order: 50,
    slots: {
      sidebar_footer(_ctx, props) {
        try {
          return <View api={api} sessionID={props.session_id} />
        } catch (e) {
          try { api.client.app.log({ body: { service: "opencode-dir-tui", level: "error", message: `sidebar_footer View throw: ${String(e).slice(0,400)}` } }).catch(() => {}) } catch {}
          return <box><text fg={api.theme.current.error}>ERR footer {String(e).slice(0,60)}</text></box> as any
        }
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-dir",
  tui,
}

export default plugin
