/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"

function View(props: { api: any; sessionID: string }) {
  const theme = () => props.api.theme.current
  const primary = createMemo(() => {
    const s = props.api.state.session.get(props.sessionID) as any
    return s?.directory ?? props.api.state.path.directory ?? "?"
  })

  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().text }}>{primary()}</span>
        <span style={{ fg: theme().textMuted }}> (opencode-dir)</span>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Open</b>
        <span style={{ fg: theme().text }}><b>Code</b></span> {props.api.app.version}
      </text>
    </box>
  )
}

export const tui: TuiPlugin = async (api: any) => {
  const log = (level: "info" | "warn" | "error", message: string) => {
    try { api.client?.app?.log?.({ body: { service: "opencode-dir-tui", level, message } })?.catch?.(() => {}) } catch {}
    try { console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[opencode-dir tui] ${message}`) } catch {}
  }
  const report = async (err: unknown) => {
    try {
      const { reportError } = await import("./lib")
      const e = err instanceof Error ? err : new Error(String(err))
      await (reportError as any)(e)
    } catch {}
  }

  log("info", "tui load id=opencode-dir")
  api.slots.register({
    order: 101,
    slots: {
      sidebar_footer(_ctx: any, props: { session_id: string }) {
        try { log("info", `sidebar_footer render sid=${props.session_id}`) } catch (e) { report(e) }
        try { return <View api={api} sessionID={props.session_id} /> } catch (e) { log("error", `View failed: ${e}`); report(e); return null as any }
      },
    },
  })
  log("info", "slots.register done order 101")
}

export default { id: "opencode-dir", tui }
