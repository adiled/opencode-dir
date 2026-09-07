/** @jsxImportSource @opentui/solid */

// @ts-nocheck
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"

function View(props: { api: TuiPluginApi; sessionID: string }) {
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

const tui: TuiPlugin = async (api) => {
  try { await api.client.app.log({ body: { service: "opencode-dir-tui", level: "info", message: `tui load id=opencode-dir ver=${api.app.version}` } }) } catch {}
  api.slots.register({
    order: 101,
    slots: {
      sidebar_footer(_ctx, props) {
        try { api.client.app.log({ body: { service: "opencode-dir-tui", level: "info", message: `sidebar_footer render sid=${props.session_id}` } }).catch(() => {}) } catch {}
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
  try { await api.client.app.log({ body: { service: "opencode-dir-tui", level: "info", message: "slots.register done order 101" } }) } catch {}
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-dir",
  tui,
}

export default plugin
