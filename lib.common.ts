import { readFileSync } from "fs"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export class UserError extends Error {}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === "string") return new Error(value)
  if (typeof value !== "object" || value === null) {
    switch (typeof value) {
      case "number":
      case "boolean":
      case "bigint":
      case "symbol":
      case "undefined":
        return new Error(String(value))
      case "string":
        return new Error(value)
      default:
        return new Error("null")
    }
  }
  try {
    return new Error(JSON.stringify(value) ?? "non-serializable object")
  } catch {
    return new Error("non-serializable object")
  }
}

export const SERVICE = "opencode-dir"

export type LogExtra = Record<string, unknown>

export function logBody(message: string, extra?: LogExtra): {
  body: { service: string; level: "info"; message: string; extra?: LogExtra }
} {
  return { body: { service: SERVICE, level: "info", message, extra } }
}

export type Logger = (message: string, extra?: LogExtra) => Promise<void>

export function reportUnexpected(err: Error): void {
  if (err instanceof UserError) return
  void reportError(err)
}

export type ReportKind = "error" | "update"

export interface ReportContext {
  kind: ReportKind
  error: Error
  url?: string
  currentVersion?: string
}

const SENTRY_DSN = "https://3dc34b92b6635091e8f0feba7bf6f9c5@o4510982366625792.ingest.us.sentry.io/4510982373769216"

export const MIN_OPENCODE_VERSION = "1.18.0"

export function normalizeVersion(version: string): string | null {
  return version === "0.0.0" || version.startsWith("0.0.0-") ? null : version
}

let serverVersion: string | null = null

export function getOpencodeVersion(): string | null {
  return serverVersion
}

export function resetOpencodeVersionCache(): void {
  serverVersion = null
}

export async function refreshOpencodeVersion(): Promise<string | null> {
  if (!process.env.OPENCODE_DIR_TEST) {
    try {
      const { stdout } = await execFileAsync("opencode", ["--version"], {
        timeout: 3000,
      })
      const version = stdout.trim()
      if (version) serverVersion = normalizeVersion(version)
    } catch {}
  }
  return getOpencodeVersion()
}

export function meetsMinVersion(version: string, min: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
    return m ? [+m[1], +m[2], +m[3]] : null
  }
  const v = parse(version)
  const target = parse(min)
  if (!v || !target) return true
  for (let i = 0; i < 3; i++) {
    if (v[i]! > target[i]!) return true
    if (v[i]! < target[i]!) return false
  }
  return true
}

let _version: string | undefined

export function getVersion(): string {
  if (!_version) {
    try {
      const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"))
      _version = pkg.version
    } catch {
      _version = "unknown"
    }
  }
  return _version!
}

export async function report(context: ReportContext): Promise<void> {
  if (process.env.OPENCODE_DIR_TEST || process.env.VITEST) return
  try {
    const os = await import("os")
    const url = new URL(SENTRY_DSN)
    const projectId = url.pathname.slice(1)
    const publicKey = url.username
    const endpoint = `https://${url.host}/api/${projectId}/envelope/`
    const version = context.currentVersion ?? getVersion()
    const update = context.kind === "update"

    const header = JSON.stringify({
      event_id: crypto.randomUUID().replace(/-/g, ""),
      dsn: SENTRY_DSN,
      sent_at: new Date().toISOString(),
    })
    const item = JSON.stringify({ type: "event" })
    const payload = JSON.stringify({
      exception: {
        values: [{
          type: context.error.name,
          value: context.error.message,
          stacktrace: {
            frames: (context.error.stack ?? "").split("\n").slice(1).map((line) => ({
              filename: line.trim(),
            })),
          },
        }],
      },
      release: `opencode-dir@${version}`,
      platform: "node",
      environment: "production",
      contexts: {
        os: { name: os.platform(), version: os.release() },
        device: { arch: os.arch() },
        runtime: { name: "node", version: process.version },
        app: { app_version: version, opencode_version: getOpencodeVersion() ?? "unknown" },
        client: { client: process.env.OPENCODE_CLIENT ?? "cli", caller: process.env.OPENCODE_CALLER ?? "unknown" },
      },
      tags: {
        ...(update ? { check_type: "update", url: context.url ?? "" } : {}),
        kind: context.kind,
        os: os.platform(),
        arch: os.arch(),
        node: process.version,
        opencode: getOpencodeVersion() ?? "unknown",
        client: process.env.OPENCODE_CLIENT ?? "cli",
        caller: process.env.OPENCODE_CALLER ?? "unknown",
      },
      extra: {
        cwd: process.cwd(),
        argv: process.argv.slice(0, 5).join(" "),
        channel: process.env.OPENCODE_CHANNEL ?? "latest",
        open_client: process.env.OPENCODE_CLIENT ?? "cli",
        open_caller: process.env.OPENCODE_CALLER ?? "unknown",
      },
    })

    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_key=${publicKey}, sentry_version=7`,
      },
      body: `${header}\n${item}\n${payload}`,
    })
  } catch {}
}

export async function reportError(err: Error): Promise<void> {
  await report({ kind: "error", error: err })
}

export type OutcomeStatus = "ok" | "info" | "error"

export type ToastVariant = "info" | "success" | "warning" | "error"

export function variantFor(status: OutcomeStatus): ToastVariant {
  if (status === "error") return "error"
  if (status === "info") return "info"
  return "success"
}

export function durationFor(status: OutcomeStatus): number {
  return status === "error" ? 8000 : 5000
}
