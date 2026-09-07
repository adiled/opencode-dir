/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { Database } from "./db"
import { getDbPath } from "./lib"

function abbreviateHome(dir: string, home: string): string {
  if (dir === home) return "~"
  if (dir.startsWith(home + "/")) return "~" + dir.slice(home.length)
  return dir
}

function View(props: { api: any; sessionID: string }) {
  const theme = () => props.api.theme.current
  let primary = ""
  let extra: string[] = []
  try {
    const s = props.api.state.session.get(props.sessionID) as any
    const dir = s?.directory ?? props.api.state.path.directory ?? ""
    const home = props.api.state.path.home ?? ""
    primary = abbreviateHome(dir, home || "")
    const db = new Database(getDbPath())
    try {
      const rows = db.query(`SELECT resource FROM permission WHERE project_id = ? AND action = 'external_directory'`).all(s.projectID ?? s.project_id) as any[]
      extra = rows.map((r: any) => abbreviateHome((r.resource as string).replace(/\/\*$/, ""), home || "")).filter((d: string) => d !== primary)
    } finally {
      db.close()
    }
  } catch {}

  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().text }}>{primary}</span>
        {extra.length ? <span style={{ fg: theme().textMuted }}> +{extra.length} add-dir: {extra.join(", ")}</span> : null}
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
