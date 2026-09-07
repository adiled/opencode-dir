/** @jsxImportSource @opentui/solid */

// @ts-nocheck
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"

function View(props: { api: any; sessionID: string }) {
  const theme = () => {
    try { return props.api.theme.current } catch (e) { return { text: "#fff", textMuted: "#888", success: "#0f0" } as any }
  }
  const primary = createMemo(() => {
    try {
      const s = props.api.state.session.get(props.sessionID) as any
      const dir = s?.directory ?? props.api.state.path.directory ?? "?"
      try { props.api.client?.app?.log?.({ body: { service: "opencode-dir-tui", level: "info", message: `View memo sid=${props.sessionID} dir=${dir} sess=${s ? JSON.stringify(s).slice(0,400) : "null"}` } })?.catch?.(() => {}) } catch {}
      return dir
    } catch (e) {
      try { props.api.client?.app?.log?.({ body: { service: "opencode-dir-tui", level: "error", message: `View memo err=${String(e)}` } })?.catch?.(() => {}) } catch {}
      return "?"
    }
  })

  try { props.api.client?.app?.log?.({ body: { service: "opencode-dir-tui", level: "info", message: `View render sid=${props.sessionID} primary=${primary()} ver=${props.api.app.version}` } })?.catch?.(() => {}) } catch {}
  try { console.log(`[opencode-dir tui] View render sid=${props.sessionID}`) } catch {}

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

  try {
    log("info", `tui load id=opencode-dir ver=${api.app?.version} order=101`)
    log("info", `api keys=${Object.keys(api || {}).join(",")}`)
    log("info", `state keys=${Object.keys(api.state || {}).join(",")} path=${JSON.stringify(api.state?.path || {}).slice(0,300)} sessions=${(api.state?.session as any)?.size ?? "?"}`)
    log("info", `theme=${JSON.stringify(api.theme?.current || {}).slice(0,300)}`)
    log("info", `tuiConfig=${JSON.stringify((api as any).tuiConfig || {}).slice(0,300)}`)
  } catch (e) { log("warn", `pre-log err ${String(e)}`); report(e) }

  try {
    api.slots.register({
      id: "opencode-dir",
      order: 101,
      slots: {
        sidebar_footer(_ctx: any, props: { session_id: string }) {
          log("info", `sidebar_footer render sid=${props.session_id}`)
          try {
            const el = <View api={api} sessionID={props.session_id} />
            log("info", `sidebar_footer View created sid=${props.session_id}`)
            return el
          } catch (e) { log("error", `View failed: ${String(e)} ${(e as any)?.stack?.slice(0,500)}`); report(e); return null as any }
        },
      },
    })
    log("info", "slots.register done id=opencode-dir order 101 sidebar_footer")
  } catch (e) {
    log("error", `slots.register failed ${String(e)} ${(e as any)?.stack?.slice(0,800)}`)
    await report(e)
    throw e
  }
}

export default { id: "opencode-dir", tui }
