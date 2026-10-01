import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { readFileSync, mkdtempSync, rmSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { execFileSync } from "child_process"
import { tmpdir } from "os"

// ===========================================================================
// Bulletproof packaging regression guard for issues #22/#23.
//
// v1.2.4 shipped WITHOUT lib.protocol.ts in npm `files`, so `index.ts` threw
// "Cannot find module './lib.protocol'" at load time and the WHOLE plugin
// failed — no /cd, /mv, /add-dir, no Sentry event (telemetry never ran).
//
// The old test only grepped the `files` list, which passed because the working
// tree always has every source file. This test replicates what a FRESH USER
// actually experiences: pack the tarball, install it + its deps into a scratch
// dir, then type-check AND compile-load `index.ts` from that installed copy.
// Any missing shipped file, undeclared dependency, or extensionless relative
// import that breaks under nodenext resolution will FAIL here — on CI, before
// a tag is ever pushed.
// ===========================================================================

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))

let scratch: string

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "opencode-dir-packaging-"))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function packTarball(): string {
  // npm pack --pack-destination writes the .tgz into scratch and prints its name
  const out = execFileSync("npm", ["pack", "--pack-destination", scratch, "--silent"], {
    cwd: root,
    encoding: "utf-8",
  }).trim()
  return join(scratch, out.split("\n").pop()!.trim())
}

function installTarball(tarball: string) {
  // Extract the packed contents (the shipped file set) and install its deps.
  // This is exactly what a fresh `npm install opencode-dir` gives a user.
  execFileSync("tar", ["xzf", tarball, "--strip-components=1"], { cwd: scratch })
  execFileSync("npm", ["install", "--no-save", "--no-package-lock"], {
    cwd: scratch,
    stdio: "ignore",
  })
}

describe("packaging (issues #22/#23) — ships, installs and LOADS", () => {
  it("lib.protocol.ts is in the published file set", () => {
    expect(pkg.files).toContain("lib.protocol.ts")
  })

  it("tarball actually contains every runtime source file", () => {
    const tarball = packTarball()
    const listing = execFileSync("tar", ["tzf", tarball], { encoding: "utf-8" })
    for (const f of ["package/index.ts", "package/lib.ts", "package/lib.common.ts", "package/lib.protocol.ts", "package/lib.vault.ts", "package/db.ts"]) {
      expect(listing).toContain(f)
    }
    installTarball(tarball)
  }, 120_000)

  it("installed package type-checks under nodenext (opencode's resolution)", () => {
    // Extensionless relative imports and missing deps FAIL under nodenext —
    // exactly the class of bug that silently broke 1.2.4 for users.
    const out = execFileSync("npx", ["tsc", "--noEmit",
      "--module", "nodenext", "--moduleResolution", "nodenext",
      "--target", "esnext", "--skipLibCheck", "index.ts"], {
      cwd: scratch, stdio: "pipe", encoding: "utf-8",
    })
    expect(out).toBe("")
  }, 60_000)

  it("installed package LOADS and registers the plugin (server + setup)", () => {
    // Compile the installed copy and run it — the real "does a fresh install
    // actually load?" check that would have caught the missing-file crash.
    execFileSync("npx", ["tsc", "--module", "nodenext", "--moduleResolution", "nodenext",
      "--target", "esnext", "--skipLibCheck", "--outDir", "out", "index.ts"], {
      cwd: scratch, stdio: "ignore",
    })
    const script = `import('./out/index.js').then(m=>{const d=m.default;` +
      `console.log(JSON.stringify({id:d.id, server:typeof d.server, setup:typeof d.setup}))` +
      `}).catch(e=>{console.error('LOAD_FAILED:'+e.message); process.exit(1)})`
    const out = execFileSync("node", ["-e", script], { cwd: scratch, encoding: "utf-8" })
    const shape = JSON.parse(out.trim())
    expect(shape.id).toBe("opencode-dir")
    expect(shape.server).toBe("function")
    expect(shape.setup).toBe("function")
  }, 60_000)

  it("all 5 slash commands register from the installed package", async () => {
    // The V1 config hook populates slash commands — the exact thing users lost.
    const mod = await import(join(scratch, "out", "index.js"))
    const plugin = await mod.default.server({ tui: { showToast: () => ({ catch: () => {} }) } })
    const input = { command: {} as Record<string, { description: string; template: string }> }
    await plugin.config!(input)
    expect(Object.keys(input.command).sort()).toEqual(
      ["add-dir", "cd", "mv", "remove-dir", "vault"].sort(),
    )
  })
})
