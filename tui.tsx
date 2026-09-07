/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

function View(props: { api: any; sessionID: string }) {
  const theme = () => props.api.theme.current
  let primary = "?"
  try {
    const s = props.api.state.session.get(props.sessionID) as any
    primary = s?.directory ?? props.api.state.path.directory ?? "?"
    // Simple abbreviate without home
    if (primary.startsWith("/Users/adil/")) primary = "~" + primary.slice("/Users/adil".length)
  } catch {}
  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().text }}>{primary}</span>
        <span style={{ fg: theme().textMuted }}> (opencode-dir)</span>
      </text>
    </box>
  )
}

export const tui: TuiPlugin = async (api: any) => {
  api.slots.register({
    id: "opencode-dir:dirs",
    slots: {
      sidebar_footer(_ctx: any, props: { session_id: string }) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

export default { id: "opencode-dir", tui }
