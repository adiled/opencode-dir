/**
 * Probe: can we launch an opencode server and get a migrated DB?
 * Run with: bun run test-server-probe.ts
 */
import { spawn } from "child_process"
import { existsSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const SANDBOX = join(tmpdir(), "ocd-server-probe")
const DATA_DIR = join(SANDBOX, "data")
const CONFIG_DIR = join(SANDBOX, "config")
const PROJECT_DIR = join(SANDBOX, "project")

// Clean slate
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(join(CONFIG_DIR, "opencode"), { recursive: true })
mkdirSync(PROJECT_DIR, { recursive: true })

console.log("sandbox:", SANDBOX)
console.log("launching opencode serve...")

const proc = spawn(
  "bun",
  ["run", "--filter", "opencode", "dev", "--", "serve", "--port", "19877", "--pure"],
  {
    cwd: "/Users/adil/opencode",
    env: {
      ...process.env,
      XDG_DATA_HOME: DATA_DIR,
      XDG_CONFIG_HOME: CONFIG_DIR,
      HOME: SANDBOX,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
)

let output = ""
proc.stdout?.on("data", (d: Buffer) => { output += d.toString() })
proc.stderr?.on("data", (d: Buffer) => { output += d.toString() })

// Give it time to start and run migrations
setTimeout(() => {
  proc.kill("SIGTERM")

  console.log("\n--- server output (first 2000 chars) ---")
  console.log(output.slice(0, 2000))

  console.log("\n--- checking for DB files ---")
  const dbPath = join(DATA_DIR, "opencode", "opencode.db")
  const dbPathLocal = join(DATA_DIR, "opencode", "opencode-local.db")
  console.log(`${dbPath}: ${existsSync(dbPath)}`)
  console.log(`${dbPathLocal}: ${existsSync(dbPathLocal)}`)

  // Check any .db files created
  const { execSync } = require("child_process")
  try {
    const files = execSync(`find ${SANDBOX} -name '*.db' 2>/dev/null`).toString().trim()
    console.log("DB files found:", files || "(none)")
  } catch {
    console.log("find failed")
  }

  // Cleanup
  rmSync(SANDBOX, { recursive: true, force: true })
  process.exit(0)
}, 6000)

proc.on("error", (err: Error) => {
  console.error("spawn error:", err.message)
  process.exit(1)
})