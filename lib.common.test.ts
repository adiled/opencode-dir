import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import {
  UserError,
  toError,
  logBody,
  report,
  reportError,
  reportUnexpected,
  variantFor,
  durationFor,
  SERVICE,
} from "./lib.common.js"
import { setV2LogSink, v2Log, v2Report, reportV2Skip } from "./lib.v2.js"

describe("lib.common", () => {
  describe("logBody", () => {
    it("builds the single envelope both surfaces send", () => {
      expect(logBody("hello", { a: 1 })).toEqual({
        body: { service: SERVICE, level: "info", message: "hello", extra: { a: 1 } },
      })
    })

    it("omits extra when absent", () => {
      expect(logBody("bare")).toEqual({
        body: { service: "opencode-dir", level: "info", message: "bare", extra: undefined },
      })
    })
  })

  describe("toError", () => {
    it("preserves a thrown non-Error instead of [object Object]", () => {
      expect(toError({ code: 7 }).message).toBe('{"code":7}')
    })

    it("passes Errors through unchanged", () => {
      const err = new Error("boom")
      expect(toError(err)).toBe(err)
    })

    it("handles non-serializable throws", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      expect(toError(cyclic).message).toBe("non-serializable object")
    })
  })

  describe("toast mapping", () => {
    it("maps every outcome status to its variant", () => {
      expect(variantFor("ok")).toBe("success")
      expect(variantFor("info")).toBe("info")
      expect(variantFor("error")).toBe("error")
    })

    it("gives errors a longer dwell than successes", () => {
      expect(durationFor("error")).toBeGreaterThan(durationFor("ok"))
      expect(durationFor("ok")).toBe(durationFor("info"))
    })
  })

  describe("report", () => {
    const fetchMock = vi.fn()

    beforeEach(() => {
      fetchMock.mockReset().mockResolvedValue({ ok: true })
      vi.stubGlobal("fetch", fetchMock)
      delete process.env.OPENCODE_DIR_TEST
      delete process.env.VITEST
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function envelope(): { header: string; item: string; payload: string } {
      const body = String(fetchMock.mock.calls[0]![1]!.body)
      const [header, item, payload] = body.split("\n")
      return { header: header!, item: item!, payload: payload! }
    }

    it("posts a sentry envelope with auth header", async () => {
      await report({ kind: "error", error: new Error("kaboom") })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(String(url)).toContain("/envelope/")
      expect((init!.headers as Record<string, string>)["X-Sentry-Auth"]).toContain("sentry_key=")
      expect(JSON.parse(envelope().payload).exception.values[0].value).toBe("kaboom")
    })

    it("tags update checks with the url and kind", async () => {
      await report({ kind: "update", error: new Error("offline"), url: "https://registry.npmjs.org/x" })
      const tags = JSON.parse(envelope().payload).tags
      expect(tags.kind).toBe("update")
      expect(tags.check_type).toBe("update")
      expect(tags.url).toBe("https://registry.npmjs.org/x")
    })

    it("omits update-only tags for plain errors", async () => {
      await reportError(new Error("plain"))
      const tags = JSON.parse(envelope().payload).tags
      expect(tags.kind).toBe("error")
      expect(tags.check_type).toBeUndefined()
    })

    it("carries the exception stack as frames", async () => {
      await report({ kind: "error", error: new Error("stacked") })
      const values = JSON.parse(envelope().payload).exception.values
      expect(Array.isArray(values[0].stacktrace.frames)).toBe(true)
    })

    it("never throws when the network fails", async () => {
      fetchMock.mockRejectedValue(new Error("offline"))
      await expect(report({ kind: "error", error: new Error("x") })).resolves.toBeUndefined()
    })

    it("stays silent under test", async () => {
      process.env.VITEST = "1"
      await report({ kind: "error", error: new Error("x") })
      expect(fetchMock).not.toHaveBeenCalled()
      delete process.env.VITEST
    })
  })

  describe("reportUnexpected", () => {
    it("excludes UserError from telemetry", () => {
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)
      delete process.env.VITEST
      reportUnexpected(new UserError("your fault"))
      expect(fetchMock).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it("reports anything that is not a UserError", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal("fetch", fetchMock)
      delete process.env.VITEST
      reportUnexpected(new Error("our fault"))
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      vi.unstubAllGlobals()
    })
  })
})

describe("v2 logging parity", () => {
  afterEach(() => {
    setV2LogSink(null)
  })

  it("drains into the installed sink instead of the file", () => {
    const lines: Array<[string, Record<string, unknown>]> = []
    setV2LogSink((message, extra) => lines.push([message, extra]))
    v2Log({ event: "session.move.ok", command: "cd", sessionID: "s1" })
    expect(lines).toEqual([["session.move.ok", { surface: "v2", command: "cd", sessionID: "s1" }]])
  })

  it("strips serialization fields the sink re-adds", () => {
    let extra: Record<string, unknown> = {}
    setV2LogSink((_message, e) => (extra = e))
    v2Log({ event: "x", ts: "T", service: "S", surface: "v2", keep: 1 })
    expect(extra).toEqual({ surface: "v2", keep: 1 })
  })

  it("survives a throwing sink", () => {
    setV2LogSink(() => {
      throw new Error("sink is down")
    })
    expect(() => v2Log({ event: "x" })).not.toThrow()
  })

  it("falls back to the log file when no sink is installed", () => {
    setV2LogSink(null)
    expect(() => v2Log({ event: "x" })).not.toThrow()
  })

  it("logs the event and reports the error together", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)
    delete process.env.VITEST
    const lines: Array<[string, Record<string, unknown>]> = []
    setV2LogSink((message, extra) => lines.push([message, extra]))
    v2Report("session.get.failed", new Error("db gone"), { command: "cd" })
    expect(lines[0]).toEqual(["session.get.failed", { surface: "v2", command: "cd", result: "db gone" }])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    vi.unstubAllGlobals()
  })

  it("logs user errors without reporting them", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    delete process.env.VITEST
    const lines: string[] = []
    setV2LogSink((message) => lines.push(message))
    v2Report("command.resolve.failed", new UserError("Directory does not exist: /nope"))
    expect(lines).toEqual(["command.resolve.failed"])
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("never logs a thrown non-Error as [object Object]", () => {
    const lines: Array<[string, Record<string, unknown>]> = []
    setV2LogSink((message, extra) => lines.push([message, extra]))
    v2Report("toast.failed", { code: 7 })
    expect(lines[0]![1].result).toBe('{"code":7}')
  })

  it("reports a skipped setup so a silent no-op is visible", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)
    delete process.env.VITEST
    reportV2Skip(["session.get", "shell.hook"])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = String(fetchMock.mock.calls[0]![1]!.body)
    expect(JSON.parse(body.split("\n")[2]!).exception.values[0].value).toContain("session.get, shell.hook")
    vi.unstubAllGlobals()
  })
})
