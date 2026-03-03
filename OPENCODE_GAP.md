# Per-session directory override in opencode core

**From:** opencode-dir plugin (github.com/adiled/opencode-dir)
**To:** opencode maintainers

## Problem

`Instance.directory` is immutable — set once at server startup via `AsyncLocalStorage`, inaccessible from plugins. When a user wants to switch a session to a different directory at runtime (e.g., navigating a monorepo), the plugin must work around this immutability through three separate hooks:

1. **`tool.execute.before`** — inject default `path`/`workdir` args so tools don't fall back to stale `Instance.directory`
2. **`shell.env`** — override `PWD` so shell processes see the correct directory
3. **`command.execute.before`** — intercept the `/cd` command, update `session.directory`, `session.project_id`, and `session.permission` in the DB

The DB updates alone aren't sufficient because the live tool execution still uses `Instance.directory` for:
- `bash.ts`: `params.workdir || Instance.directory`
- `glob.ts`: `params.path ?? Instance.directory`
- `grep.ts`: `params.path ?? Instance.directory`
- `read.ts`, `write.ts`, `edit.ts`: `path.resolve(Instance.directory, relativePath)`

## Current workaround cost

Even with the minimal approach (default injection, no path rewriting), the plugin must:
- Maintain an in-memory `Map<sessionId, Override>` of directory overrides
- Persist that map to disk so it survives restarts
- Hook into every tool execution to check for overrides and inject defaults
- Hook into shell env to override PWD
- Cannot fix relative path resolution for read/write/edit (they resolve against `Instance.directory` internally, before the plugin sees the result)

## Proposed solution

Add a per-session directory override that tools respect when resolving their default path.

### Option A: Session-scoped Instance.directory override (preferred)

When `session.directory` differs from `Instance.directory`, tool execution should use `session.directory` as the fallback instead of `Instance.directory`.

In `prompt.ts`, where the session is loaded before tool execution (around line 1859), the session's `directory` field is already available. The change would be:

```ts
// Pseudocode — in the tool execution context
const effectiveDirectory = session.directory ?? Instance.directory

// Then in each tool's fallback:
// bash.ts:  params.workdir || effectiveDirectory
// glob.ts:  params.path ?? effectiveDirectory
// grep.ts:  params.path ?? effectiveDirectory
// read.ts:  path.resolve(effectiveDirectory, filepath)
// etc.
```

This could be implemented as a new `Instance.effectiveDirectory(sessionId)` method, or by having `prompt.ts` wrap tool execution in a nested `Instance.provide()` scope with the session's directory when it differs from the instance directory.

### Option B: New plugin hook for directory resolution

```ts
"instance.directory": async (input, output) => {
  // input: { sessionID, directory }
  // output: { directory } (mutable)
}
```

Called whenever `Instance.directory` is consumed as a fallback in tool execution. Plugins can override the value per-session.

### Option C: Nested Instance.provide() from plugin

Expose `Instance.provide()` (or a wrapper) to plugins so they can wrap tool execution in a new ALS scope with a different directory. This is the most flexible but requires careful lifecycle management.

## What this would eliminate

With Option A, the opencode-dir plugin would reduce to:

```ts
"command.execute.before": async (input, output) => {
  // Parse /cd or /mv, validate target, update session DB
  // That's it. No tool interception, no env override, no override map.
}
```

No `tool.execute.before` hook. No `shell.env` hook. No in-memory override map. No persistence file. The session's `directory` column — which already exists and is already updated by the plugin — would be the single source of truth.

## Impact

- Enables robust directory switching for monorepo workflows
- Fixes the relative path resolution gap (read/write/edit currently can't be fixed from a plugin)
- Removes an entire class of path-rewriting bugs (the plugin previously had a path-rewriting layer that caused infinite loops when moving into child directories)
- Makes the `session.directory` column actually meaningful at runtime, not just metadata

## References

- `packages/opencode/src/project/instance.ts` — Instance module, ALS context
- `packages/opencode/src/server/server.ts` — per-request `Instance.provide()` middleware
- `packages/opencode/src/session/prompt.ts` — session loading + tool execution context
- `packages/opencode/src/tool/bash.ts` — `params.workdir || Instance.directory`
- `packages/opencode/src/tool/glob.ts` — `params.path ?? Instance.directory`
- `packages/opencode/src/tool/grep.ts` — `params.path ?? Instance.directory`
- `packages/opencode/src/tool/read.ts` — `path.resolve(Instance.directory, filepath)`
- `packages/opencode/src/tool/write.ts` — `path.join(Instance.directory, params.filePath)`
- `packages/opencode/src/tool/edit.ts` — `path.join(Instance.directory, params.filePath)`
