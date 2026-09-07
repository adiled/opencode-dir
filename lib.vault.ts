import { existsSync, statSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { join, resolve, dirname } from "path"
import { tmpdir } from "os"
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto"
import { Database } from "./db"
import { appendDirPermission, removeDirPermission } from "./lib"

function keychainGet(key: string): string | null {
  try {
    const { execSync } = require("child_process")
    if (process.platform === "darwin") {
      return execSync(`security find-generic-password -s "${key}" -w 2>/dev/null`, { encoding: "utf-8" }).trim() || null
    }
    if (process.platform === "linux") {
      return execSync(`secret-tool lookup opencode-dir ${key} 2>/dev/null`, { encoding: "utf-8" }).trim() || null
    }
  } catch {}
  return null
}
function keychainSet(key: string, val: string) {
  const { execSync } = require("child_process")
  if (process.platform === "darwin") {
    execSync(`security delete-generic-password -s "${key}" 2>/dev/null || true`); execSync(`security add-generic-password -s "${key}" -a "${process.env.USER}" -w "${val.replace(/"/g, '\\"')}" 2>/dev/null`)
  } else if (process.platform === "linux") {
    execSync(`printf "%s" "${val.replace(/"/g, '\\"')}" | secret-tool store --label="opencode-dir ${key}" opencode-dir ${key} 2>/dev/null`)
  } else {
    throw new Error("keychain not supported")
  }
}
export function getVaultPassFile(sessionId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir()
  const base = process.env.XDG_DATA_HOME || (home + "/.local/share")
  return `${base}/opencode/opencode-dir/vault-pass-${sessionId}`
}
export function getGlobalVaultPassFile(): string {
  const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir()
  const base = process.env.XDG_DATA_HOME || (home + "/.local/share")
  return `${base}/opencode/opencode-dir/vault-pass-global`
}
export function getVaultPass(sessionId?: string): string | null {
  if (sessionId) {
    const k = keychainGet(`opencode-dir-vault-${sessionId}`); if (k) return k
  }
  const kg = keychainGet("opencode-dir-vault-global"); if (kg) return kg
  if (process.env.OPENCODE_DIR_VAULT_PASS) return process.env.OPENCODE_DIR_VAULT_PASS
  return null
}
export function setVaultPass(sessionId: string | null, pass: string) {
  if (sessionId) keychainSet(`opencode-dir-vault-${sessionId}`, pass)
  else keychainSet("opencode-dir-vault-global", pass)
}
export function needVaultPassFile(sessionId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir()
  const base = process.env.XDG_DATA_HOME || (home + "/.local/share")
  return `${base}/opencode/opencode-dir/vault-need-${sessionId}`
}

export function getVaultTmp(sessionId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir()
  const base = process.env.XDG_DATA_HOME || (home + "/.local/share")
  return `${base}/opencode/opencode-dir/vault-${sessionId}`
}
function vaultRegistryPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir()
  const base = process.env.XDG_DATA_HOME || (home + "/.local/share")
  return `${base}/opencode/opencode-dir/vaults.json`
}
function readRegistry(): Record<string, string> {
  try { return JSON.parse(readFileSync(vaultRegistryPath(), "utf-8")) } catch { return {} }
}
function writeRegistry(map: Record<string, string>) {
  try { mkdirSync(require("path").dirname(vaultRegistryPath()), { recursive: true }); writeFileSync(vaultRegistryPath(), JSON.stringify(map)) } catch {}
}

function deriveKey(pass: string): Buffer {
  return createHash("sha256").update(pass).digest()
}

function encryptDir(dir: string, pass: string, out: string) {
  const key = deriveKey(pass)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  // tar-like: concat files as JSON
  const files: Record<string, string> = {}
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isFile()) files[f] = readFileSync(p, "utf-8")
  }
  const plain = JSON.stringify(files)
  const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()])
  const tag = cipher.getAuthTag()
  writeFileSync(out, Buffer.concat([iv, tag, enc]))
}

function decryptDir(encFile: string, pass: string, outDir: string) {
  const key = deriveKey(pass)
  const buf = readFileSync(encFile)
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf-8")
  const files = JSON.parse(plain) as Record<string, string>
  mkdirSync(outDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outDir, name), content)
  }
}

export function vaultInit(dir: string, pass: string): { ok: boolean; error?: string } {
  const abs = resolve(dir.replace(/^~/, process.env.HOME || ""))
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { ok: false, error: "vault init requires directory" }
  const out = abs + ".age"
  try {
    encryptDir(abs, pass, out)
    rmSync(abs, { recursive: true, force: true })
    return { ok: true }
  } catch (e: unknown) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

export function vaultOpen(db: Database, sessionId: string, dir: string, pass: string): { ok: boolean; tmp?: string; error?: string } {
  const abs = resolve(dir.replace(/^~/, process.env.HOME || ""))
  const enc = abs + ".age"
  if (!existsSync(enc)) return { ok: false, error: "vault not initialized" }
  const tmp = getVaultTmp(sessionId)
  try {
    rmSync(tmp, { recursive: true, force: true })
    decryptDir(enc, pass, tmp)
    const st = appendDirPermission(db, sessionId, tmp)
    if (st === 0) return { ok: false, error: "session not found" }
    const reg = readRegistry(); reg[tmp] = abs; writeRegistry(reg)
    return { ok: true, tmp }
  } catch (e: unknown) {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
    return { ok: false, error: e instanceof Error ? e.message : "decrypt failed" }
  }
}

export function vaultClose(db: Database, sessionId: string, dir: string, pass: string): { ok: boolean; error?: string } {
  const abs = resolve(dir.replace(/^~/, process.env.HOME || ""))
  const enc = abs + ".age"
  const tmp = getVaultTmp(sessionId)
  try {
    if (existsSync(tmp)) {
      encryptDir(tmp, pass, enc)
      rmSync(tmp, { recursive: true, force: true })
    }
    removeDirPermission(db, sessionId, tmp)
    const reg = readRegistry(); delete reg[tmp]; writeRegistry(reg)
    return { ok: true }
  } catch (e: unknown) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}
