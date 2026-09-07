import { existsSync, statSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto"
import { Database } from "./db"
import { appendDirPermission, removeDirPermission } from "./lib"

export function getVaultTmp(sessionId: string): string {
  return join(tmpdir(), `vault-${sessionId}`)
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
  } catch (e: any) { return { ok: false, error: e.message } }
}

export function vaultOpen(db: Database, sessionId: string, dir: string, pass: string): { ok: boolean; tmp?: string; error?: string } {
  const abs = resolve(dir.replace(/^~/, process.env.HOME || ""))
  const enc = abs + ".age"
  if (!existsSync(enc)) return { ok: false, error: "vault not initialized" }
  const tmp = getVaultTmp(sessionId)
  try {
    rmSync(tmp, { recursive: true, force: true })
    decryptDir(enc, pass, tmp)
    // WAL txn via appendDirPermission
    const st = appendDirPermission(db, sessionId, tmp)
    if (st === 0) return { ok: false, error: "session not found" }
    return { ok: true, tmp }
  } catch (e: any) {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
    return { ok: false, error: e.message || "decrypt failed" }
  }
}

export function vaultClose(db: Database, sessionId: string, dir: string, pass: string): { ok: boolean; error?: string } {
  const abs = resolve(dir.replace(/^~/, process.env.HOME || ""))
  const enc = abs + ".age"
  const tmp = getVaultTmp(sessionId)
  try {
    if (existsSync(tmp)) {
      // re-encrypt if changed
      encryptDir(tmp, pass, enc)
      rmSync(tmp, { recursive: true, force: true })
    }
    removeDirPermission(db, sessionId, tmp)
    return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
}
