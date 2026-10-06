import { describe, it, expect } from "vitest"

describe("V1/V2 dual plugin shape", () => {
  it("server default has id + server (V1) and setup (V2 promise)", async () => {
    const mod = await import("./index.ts")
    const def = mod.default as { id: string; server: unknown; setup: unknown }
    expect(def.id).toBe("opencode-dir")
    expect(typeof def.server).toBe("function")
    expect(typeof def.setup).toBe("function")
  })

  it("tui default has id + tui (V1) and setup (V2 promise, effect-free)", async () => {
    const mod = await import("./tui.tsx")
    const def = mod.default as { id: string; tui: unknown; effect?: unknown; setup: unknown }
    expect(def.id).toBe("opencode-dir")
    expect(typeof def.tui).toBe("function")
    expect(typeof def.setup).toBe("function")
    // The `effect` hook would drag the 46 MB `effect` package into every
    // consumer's install; the host falls back to `setup` when it is absent.
    expect(def.effect).toBeUndefined()
  })

  it("tui View still renders", async () => {
    const { View } = await import("./tui.tsx")
    expect(typeof View).toBe("function")
  })

  it("reports exactly the surfaces setupV2 is gated on", async () => {
    const { setV2LogSink } = await import("./lib.v2.js")
    const events: Record<string, unknown>[] = []
    setV2LogSink((message, extra) => {
      if (message === "setup.skipped") events.push(extra)
    })
    const { default: mod } = await import("./index.ts")
    await (mod.setup as (ctx: unknown) => Promise<unknown>)({})
    setV2LogSink(null)

    expect(events).toHaveLength(1)
    expect(events[0]!.missing).toEqual([
      "command.transform",
      "session.get",
      "session.update",
      "shell.hook",
      "tool.hook",
    ])
  })

  it("does not skip setup when only the optional toast rpc is absent", async () => {
    const { setV2LogSink } = await import("./lib.v2.js")
    const events: Record<string, unknown>[] = []
    setV2LogSink((message, extra) => {
      if (message === "setup.skipped") events.push(extra)
    })
    const ctx = {
      app: { name: "opencode", version: "2.0.20", channel: "stable" },
      options: {},
      command: { transform: async () => ({ dispose: async () => {} }) },
      session: { get: async () => ({ permissions: [], location: { directory: "/tmp" } }), update: async () => {} },
      shell: { hook: async () => ({ dispose: async () => {} }) },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      rpc: undefined,
    }
    const { default: mod } = await import("./index.ts")
    await (mod.setup as (c: unknown) => Promise<unknown>)(ctx)
    setV2LogSink(null)

    expect(events).toEqual([])
  })
})

describe("v2 tui setup", () => {
  function mockContext() {
    const claims: Array<Record<string, unknown>> = []
    const toasts: Array<Record<string, unknown>> = []
    let listener: ((event: unknown) => void) | undefined
    let slotDisposed = false
    let listenDisposed = false
    const ctx: Record<string, never> = {
      ui: {
        slot: (claim: Record<string, unknown>) => {
          claims.push(claim)
          return () => {
            slotDisposed = true
          }
        },
        toast: {
          show: (input: Record<string, unknown>) => {
            toasts.push(input)
          },
        },
      },
      data: {
        listen: (handler: (event: unknown) => void) => {
          listener = handler
          return () => {
            listenDisposed = true
          }
        },
      },
    }
    const emit = (event: unknown) => listener?.(event)
    return {
      ctx,
      claims,
      toasts,
      emit,
      slotDisposed: () => slotDisposed,
      listenDisposed: () => listenDisposed,
    }
  }

  it("claims the sidebar footer and disposes it", async () => {
    const mod = await import("./tui.tsx")
    const def = mod.default as { setup: (ctx: unknown) => Promise<() => void> }
    const { ctx, claims, slotDisposed } = mockContext()
    const dispose = await def.setup(ctx)
    expect(claims).toHaveLength(1)
    expect(claims[0]!.append).toBe("sidebar.footer")
    expect(typeof claims[0]!.render).toBe("function")
    dispose()
    expect(slotDisposed()).toBe(true)
  })

  it("shows a toast for the server-side rpc toast event", async () => {
    const mod = await import("./tui.tsx")
    const def = mod.default as { setup: (ctx: unknown) => Promise<() => void> }
    const { ctx, toasts, emit } = mockContext()
    await def.setup(ctx)
    emit({ details: { type: "rpc.opencode-dir.toast", data: { title: "opencode-dir", message: "moved", variant: "success" } } })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.message).toBe("moved")
    expect(toasts[0]!.variant).toBe("success")
  })

  it("ignores unrelated events and payloads without a message", async () => {
    const mod = await import("./tui.tsx")
    const def = mod.default as { setup: (ctx: unknown) => Promise<() => void> }
    const { ctx, toasts, emit } = mockContext()
    await def.setup(ctx)
    emit({ details: { type: "session.updated", data: { message: "nope" } } })
    emit({ details: { type: "rpc.opencode-dir.toast", data: {} } })
    emit(undefined)
    expect(toasts).toHaveLength(0)
  })

  it("tears down the event listener", async () => {
    const mod = await import("./tui.tsx")
    const def = mod.default as { setup: (ctx: unknown) => Promise<() => void> }
    const { ctx, listenDisposed } = mockContext()
    const dispose = await def.setup(ctx)
    dispose()
    expect(listenDisposed()).toBe(true)
  })

  it("survives a context without slot or listen", async () => {
    const mod = await import("./tui.tsx")
    const def = mod.default as { setup: (ctx: unknown) => Promise<() => void> }
    const dispose = await def.setup({})
    expect(typeof dispose).toBe("function")
    dispose()
  })
})
