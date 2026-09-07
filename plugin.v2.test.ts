import { describe, it, expect } from "vitest"

describe("V1/V2 dual plugin shape", () => {
  it("server default has id + server (V1) and effect/setup (V2)", async () => {
    const mod: any = await import("./index.ts")
    const def = mod.default
    expect(def.id).toBe("opencode-dir")
    expect(typeof def.server).toBe("function") // V1
    expect(typeof def.effect).toBe("function") // V2
    expect(typeof def.setup).toBe("function") // V2 alias
  })

  it("tui default has id + tui (V1) and effect/setup (V2)", async () => {
    const mod: any = await import("./tui.tsx")
    const def = mod.default
    expect(def.id).toBe("opencode-dir")
    expect(typeof def.tui).toBe("function") // V1
    expect(typeof def.effect).toBe("function") // V2
    expect(typeof def.setup).toBe("function")
  })

  it("tui View still renders", async () => {
    const { View } = await import("./tui.tsx")
    expect(typeof View).toBe("function")
  })
})
