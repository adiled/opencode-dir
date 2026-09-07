import { describe, it, expect } from "vitest"

describe("V1/V2 dual plugin shape", () => {
  it("server default has id + server (V1) and setup (V2 promise)", async () => {
    const mod = await import("./index.ts")
    const def = mod.default as { id: string; server: unknown; setup: unknown }
    expect(def.id).toBe("opencode-dir")
    expect(typeof def.server).toBe("function")
    expect(typeof def.setup).toBe("function")
  })

  it("tui default has id + tui (V1) and effect/setup (V2)", async () => {
    const mod = await import("./tui.tsx")
    const def = mod.default as { id: string; tui: unknown; effect: unknown; setup: unknown }
    expect(def.id).toBe("opencode-dir")
    expect(typeof def.tui).toBe("function")
    expect(typeof def.effect).toBe("function")
    expect(typeof def.setup).toBe("function")
  })

  it("tui View still renders", async () => {
    const { View } = await import("./tui.tsx")
    expect(typeof View).toBe("function")
  })
})
