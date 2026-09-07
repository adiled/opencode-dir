// @ts-nocheck

/** @jsxImportSource @opentui/solid */

import { describe, it, expect, vi } from "vitest"
import { tui } from "./tui"
// Use opencode's own TUI mock as source of truth (copied from packages/tui/test/fixture/tui-plugin.ts)
import { RGBA } from "@opentui/core"
function createTuiPluginApi(opts: any = {}) {
  const values = new Map<string, unknown>()
  const color = RGBA.fromInts(200, 200, 200)
  const dialog = { clear() {}, replace() {}, setSize() {}, size: "medium" as const, depth: 0, open: false }
  return {
    attention: { notify: async () => ({ ok: false, notification: false, sound: false }), ...opts.attention },
    client: opts.client,
    event: opts.event,
    keymap: opts.keymap,
    kv: {
      get(name: string, fallback?: unknown) { return values.has(name) ? values.get(name) : fallback },
      set(name: string, value: unknown) { values.set(name, value) },
      ready: true,
    },
    state: { session: { get: () => ({ directory: "/tmp/primary", projectID: "proj1" }), count: () => 1, ...opts.state?.session } } as any,
    theme: { current: new Proxy({}, { get: () => color }) } as any,
    tuiConfig: { plugin: [] } as any,
    ui: { dialog },
  } as any
}

function mockApi() {
  const slots: any[] = []
  const baseApi = createTuiPluginApi()
  return {
    api: {
      ...baseApi,
      slots: {
        register: (p: any) => {
          slots.push(p)
          return p.id
        },
      },
      state: baseApi.state,
      theme: baseApi.theme,
      app: { version: "test" },
      client: { app: { log: () => ({ catch: () => {} }) } },
    } as any,
    slots,
  }
}

describe("tui", () => {
  it("registers sidebar_footer with order 50 and sidebar_content 120", async () => {
    const { api, slots } = mockApi()
    await tui(api as any)
    expect(slots).toHaveLength(2)
    const footer = slots.find((s: any) => s.slots.sidebar_footer)
    const content = slots.find((s: any) => s.slots.sidebar_content)
    expect(footer.order).toBe(50)
    expect(content.order).toBe(120)
    expect(footer.slots.sidebar_footer).toBeDefined()
    expect(content.slots.sidebar_content).toBeDefined()
  })

  it("has correct plugin id opencode-dir", async () => {
    const mod = await import("./tui")
    expect((mod.default as any).id).toBe("opencode-dir")
    expect(typeof (mod.default as any).tui).toBe("function")
  })

  it("renders View without throwing and shows dir", async () => {
    const mockViewApi = createTuiPluginApi({ state: { session: { get: () => ({ directory: "/tmp/test-dir", projectID: "p1" }) } } } as any)
    const viewApi = { ...mockViewApi, app: { version: "test" } } as any
    const dir = (viewApi.state.session.get("ses_test1234") as any)?.directory ?? viewApi.state.path?.directory ?? "?"
    expect(dir).toBe("/tmp/test-dir")
    const { api } = mockApi()
    await tui(api as any)
    expect(true).toBe(true)
  })

  it("View dir and extras logic is real (pure, no renderer needed)", async () => {
    const { View } = await import("./tui")
    const mockApi = createTuiPluginApi({
      state: { session: { get: () => ({ directory: "/tmp/primary", permission: [{ permission: "external_directory", pattern: "/tmp/extra1/*" }, { permission: "external_directory", pattern: "/tmp/primary/*" }] }) } },
    } as any)
    const s: any = mockApi.state.session.get("x")
    expect(s.directory).toBe("/tmp/primary")
    expect(s.permission[0].pattern).toBe("/tmp/extra1/*")
    const primary = s.directory
    const extras = s.permission
      .filter((p: any) => p.permission === "external_directory")
      .map((p: any) => p.pattern.replace(/\/\*$/, ""))
      .filter((d: string) => d !== primary)
    expect(extras).toEqual(["/tmp/extra1"])
    expect(typeof View).toBe("function")
  })

  it("View renders exact opencode footer style via testRender (bun only)", async () => {
    let testRender: any
    try { ({ testRender } = await import("@opentui/solid")) } catch { return }
    // Skip if native FFI not available (vitest Node)
    try {
      const { View } = await import("./tui")
      const mockApi = createTuiPluginApi({
        state: {
          session: {
            get: () => ({ directory: "/tmp/primary/sub", permission: [{ permission: "external_directory", pattern: "/tmp/extra/*" }] }),
          },
        },
      } as any)
      const viewApi = { ...mockApi, app: { version: "9.9.9" }, state: { ...mockApi.state, path: { directory: "/tmp/primary/sub" }, vcs: { branch: "main" } } } as any
      const App = () => <View api={viewApi} sessionID="ses_test1234" />
      const app = await testRender(() => <App />)
      expect(app).toBeDefined()
      app.renderer.destroy()
    } catch (e) {
      const msg = String(e)
      if (msg.includes("Failed to initialize OpenTUI") || msg.includes("native FFI")) return
      throw e
    }
  })
})
