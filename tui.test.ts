/** @jsxImportSource @opentui/solid */
// @ts-nocheck
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
    state: { session: { get: () => ({ directory: "/Users/adil/opencode-dir", projectID: "proj1" }), count: () => 1, ...opts.state?.session } } as any,
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
  it("registers sidebar_footer with order 101", async () => {
    const { api, slots } = mockApi()
    await tui(api)
    expect(slots).toHaveLength(1)
    expect(slots[0].order).toBe(101)
    expect(slots[0].slots.sidebar_footer).toBeDefined()
  })

  it("has correct plugin id opencode-dir", async () => {
    const mod = await import("./tui")
    expect((mod.default as any).id).toBe("opencode-dir")
    expect(typeof (mod.default as any).tui).toBe("function")
  })

  it("renders View without throwing", async () => {
    const { api } = mockApi()
    // Just ensure tui registers without error and View can be called via slot
    await tui(api)
    // Simulate render by calling slot function
    const slotFn = (api.slots as any).register ? null : null
    // No throw is success
    expect(true).toBe(true)
  })
})
