import { describe, it, expect } from "bun:test"
import { meetsMinVersion } from "./lib"

describe("meetsMinVersion", () => {
  it("returns true when version equals minimum", () => {
    expect(meetsMinVersion("1.4.3", "1.4.3")).toBe(true)
  })
  it("returns true when version exceeds minimum", () => {
    expect(meetsMinVersion("1.5.0", "1.4.3")).toBe(true)
    expect(meetsMinVersion("2.0.0", "1.4.3")).toBe(true)
    expect(meetsMinVersion("1.4.4", "1.4.3")).toBe(true)
  })
  it("returns false when version is below minimum", () => {
    expect(meetsMinVersion("1.4.2", "1.4.3")).toBe(false)
    expect(meetsMinVersion("1.3.9", "1.4.3")).toBe(false)
    expect(meetsMinVersion("0.9.0", "1.4.3")).toBe(false)
  })
  it("returns true for non-semver values (dev builds)", () => {
    expect(meetsMinVersion("local", "1.4.3")).toBe(true)
    expect(meetsMinVersion("dev", "1.4.3")).toBe(true)
  })
  it("returns true when minimum is non-semver", () => {
    expect(meetsMinVersion("1.0.0", "local")).toBe(true)
  })
})