# opencode-dir — Handover Document

## What is this?

An opencode plugin that adds `/cd` and `/mv` commands to move sessions between directories/repos at runtime. Built for monorepo and cross-repo workflows where restarting opencode every time you switch context is painful.

- **Repo:** `github.com/adiled/opencode-dir`
- **npm:** `opencode-dir@0.1.x`
- **Author:** Adil Shaikh (`hello@adils.me`)
- **License:** MIT

## Architecture

### File structure

```
index.ts   — Thin plugin wrapper (hooks, logging, override management)
lib.ts     — All core logic (exported, testable)
test/
  lib.test.ts — 31 tests covering every exported function
```

The plugin is loaded from `~/.config/opencode/plugins/`. Both `opencode-dir.ts` (copy of `index.ts`) and `lib.ts` must be present in that directory. The import `./lib` resolves relative to the plugin file's location.

### How /cd and /mv differ

| | `/cd <path>` | `/mv <path>` |
|---|---|---|
| Updates session directory + project_id | Yes | Yes |
| Writes session.permission | Yes | Yes |
| Rewrites message history paths | No | Yes |
| Registers runtime override | Yes | Yes |

Both are implemented by a single function: `execMove(sessionId, targetPath, rewrite, db?)`. The `rewrite` flag controls whether message paths are rewritten.

### Plugin hooks used

| Hook | Purpose |
|---|---|
| `command.execute.before` | Intercepts `/cd` and `/mv` commands |
| `tool.execute.before` | Rewrites file paths in tool args (old dir → new dir) |
| `shell.env` | Injects correct `PWD` for shell executions |

### Hook NOT used

| Hook | Why |
|---|---|
| `permission.ask` | Dead for most tools. `PermissionNext` (the new permission system) does NOT call this hook. Only the old `Permission.ask()` does, which is only used by the bash tool directly. All other tools (read, write, edit, glob, grep) use `PermissionNext` via `assertExternalDirectory()` → `ctx.ask()`. |

## Critical Architecture Discoveries (opencode internals)

### Two permission systems

1. **Old:** `Permission.ask()` in `packages/opencode/src/permission/index.ts` — calls `Plugin.trigger("permission.ask", ...)`. Used by bash tool.
2. **New:** `PermissionNext.ask()` in `packages/opencode/src/permission/next.ts` — config-based rulesets. Does NOT call the plugin hook. Used by read, write, edit, glob, grep via `assertExternalDirectory()`.

### How we bypass permissions (the key insight)

`PermissionNext.ask()` merges two rulesets:

```ts
ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
```

The `session.permission` column on the session table is the official per-session permission override. We write to it:

```json
[{"permission": "external_directory", "pattern": "<newDir>/*", "action": "allow"}]
```

This works because `command.execute.before` fires BEFORE `prompt()` loads the session from DB (see `prompt.ts` line 1859-1869). So by the time tools run, the session object already has our permission rule.

The `*` pattern in `<dir>/*` matches all nested paths because opencode's `Wildcard.match()` converts `*` to `.*` regex. So `/root/bonga/*` matches `/root/bonga/sub/deep/file.ts` — no repeated permission prompts for subdirectories.

### Instance.directory is immutable

Set at server startup via `AsyncLocalStorage`. Cannot be changed from a plugin. The bundled binary's module-level closures (`cache`, `context`) are unreachable from plugin code. This is why we need runtime tool interception — even after `/cd`, `Instance.directory` still points to the original launch directory.

### Bash tool cwd resolution

```ts
const cwd = params.workdir || Instance.directory
```

Falls back to `Instance.directory`, NOT `process.cwd()`. So `process.chdir()` alone doesn't fix bash. The plugin injects `workdir` via `tool.execute.before`.

### assertExternalDirectory flow

```
tool.execute(args, ctx)
  → assertExternalDirectory(ctx, filepath)
    → Instance.containsPath(filepath)  // checks against immutable Instance.directory
    → if external: ctx.ask({permission: "external_directory", patterns: [glob], ...})
      → PermissionNext.ask({...req, ruleset: merge(agent.permission, session.permission)})
        → evaluate() checks against merged rulesets
```

Our `tool.execute.before` runs before `assertExternalDirectory`. The path is already rewritten to the new directory, which IS external to `Instance.directory`. The session.permission rule we wrote is what prevents the prompt.

### Session listing

`Session.list()` filters by `project_id`. After `/cd`, the session's `project_id` is changed to the target repo's initial commit hash. The session will appear under the target project's list.

### getInitialCommit alignment

Must use `--all` flag to match opencode's `Project.fromDirectory` logic: `git rev-list --max-parents=0 --all`, split/filter/sort, take first.

### Plugin console.log

Goes to TUI stdout (swallowed). Debug logging writes to `~/.local/share/opencode/opencode-dir-debug.log` via `appendFileSync`, gated behind `OPENCODE_DIR_DEBUG=1` env var.

### Config update APIs

| API | What it does | Why we don't use it |
|---|---|---|
| `client.config.update()` | Writes to `<Instance.directory>/config.json`, triggers `Instance.dispose()` | Writes to wrong directory, causes reload that wipes in-memory state |
| `client.global.config.update()` | Would write to `~/.config/opencode/opencode.json`, trigger `Instance.disposeAll()` | SDK plugin client doesn't expose `.global` — `TypeError: undefined is not an object` |

Neither is needed. The `session.permission` DB write is sufficient and avoids all reload issues.

### Permission table (project-scoped, unused by us)

The `permission` table stores rulesets keyed by `project_id`. `PermissionNext.state()` loads from it. But:
- opencode itself never writes to it (the save path is commented out with a TODO)
- It's project-scoped, not session-scoped — writing here would leak permissions to all sessions in the project
- We previously used it but switched to `session.permission` for proper scoping

### Session.permission (what we use)

The `session` table has a `permission` column (`TEXT, JSON`). Format: `PermissionNext.Ruleset` (array of `{permission, pattern, action}`). This is the official per-session permission mechanism — opencode's own `Session.setPermission()` writes to it. Merged into the ruleset at tool execution time. Session-scoped, survives restarts, doesn't leak to other sessions.

## Runtime state

### dirOverrides Map

`Map<sessionId, {oldDir, newDir}>` — lives in memory, persisted to `~/.local/share/opencode/opencode-dir-overrides.json` (0600 permissions). Loaded on plugin init so overrides survive restarts. Used by `tool.execute.before` and `shell.env` to rewrite paths.

### PATH_TOOLS

Maps tool IDs to their path-carrying arg keys:

```ts
read: ["filePath"], write: ["filePath"], edit: ["filePath"],
glob: ["path"], grep: ["path"], bash: ["workdir"]
```

### Bash special handling

Beyond `workdir` injection, the plugin also `replaceAll(oldDir, newDir)` on `args.command` to catch hardcoded absolute paths in bash commands.

## Testing

```bash
cd /root/opencode-dir
bun test
```

31 tests, all in `test/lib.test.ts`. Tests use in-memory SQLite (`:memory:`) with `createSchema()` for DB tests, and temp git repos (with GPG signing disabled) for git-dependent tests. Test helpers: `createTestDb()`, `createGitRepo()`, `stubSession()`, `stubMessage()`.

Coverage:
- `rewritePath` — exact match, prefix, unrelated, partial name
- `loadOverrides` / `persistOverrides` — missing file, round-trip, file permissions
- `getInitialCommit` — real repo, non-git dir
- `resolveTarget` — real repo, nonexistent, non-git
- `ensureProject` — create, idempotent
- `updateSession` — updates all fields + permission, nonexistent session
- `getSessionInfo` — found, not found
- `getCurrentDirectory` — from message path, no path info
- `rewriteMessages` — rewrites path fields, leaves pathless messages alone
- `execMove` — cd (no rewrite), mv (rewrite), global→git, nonexistent session, already-there noop, permission written, project created
- `PATH_TOOLS` — known tools mapped, unknown tools absent

## Deployment

### Plugin sync (manual dev workflow)

```bash
cp /root/opencode-dir/index.ts ~/.config/opencode/plugins/opencode-dir.ts
cp /root/opencode-dir/lib.ts ~/.config/opencode/plugins/lib.ts
```

Both files must be copied. Restart opencode after sync.

### npm publishing

CI workflow (`.github/workflows/publish.yml`) triggers on every push to `main`:

1. Compares `package.json` version with published npm version
2. If same → auto-bumps patch (e.g. `0.1.1` → `0.1.2`), commits, tags
3. If different (manual bump) → skips auto-bump, just tags
4. Publishes to npm with provenance

Requires `NPM_TOKEN` secret on the GitHub repo.

### Manual minor/major bump

```bash
# Edit package.json version to e.g. 0.2.0
git add package.json
git commit -m "chore: bump to v0.2.0"
git push origin main
# CI detects version differs from npm → tags v0.2.0 and publishes
```

## Git config

- Remote: `github.com/adiled/opencode-dir`
- User: Adil Shaikh / `hello@adils.me`
- GPG signing: disabled
- Default branch: `main`

## Key source files in opencode (for future reference)

All paths relative to `github.com/anomalyco/opencode` branch `dev`:

| File | What's there |
|---|---|
| `packages/opencode/src/permission/next.ts` | PermissionNext system, `ask()`, `evaluate()`, `state()`, `fromConfig()` |
| `packages/opencode/src/permission/index.ts` | Old Permission system, calls `Plugin.trigger("permission.ask")` |
| `packages/opencode/src/tool/external-directory.ts` | `assertExternalDirectory()` — the gate that triggers permission prompts |
| `packages/opencode/src/tool/bash.ts` | `cwd = params.workdir \|\| Instance.directory` |
| `packages/opencode/src/tool/read.ts` | Example of tool calling `assertExternalDirectory` |
| `packages/opencode/src/session/prompt.ts` | `command.execute.before` trigger (line 1859), `tool.execute.before` trigger (line 792), `ctx.ask()` with `session.permission` merge (line 776) |
| `packages/opencode/src/session/index.ts` | `Session.setPermission()` — opencode's own session permission writer |
| `packages/opencode/src/session/session.sql.ts` | Schema — `session.permission` column, `PermissionTable` |
| `packages/opencode/src/project/instance.ts` | `Instance.provide()`, `Instance.directory` (immutable), `Instance.containsPath()` |
| `packages/opencode/src/plugin/index.ts` | Plugin loading, `Plugin.trigger()` |
| `packages/opencode/src/config/config.ts` | `Config.update()`, `Config.updateGlobal()` |
| `packages/opencode/src/server/server.ts` | Server middleware, `x-opencode-directory` header, `Instance.provide()` per request |
| `packages/opencode/src/util/wildcard.ts` | `Wildcard.match()` — `*` becomes `.*` regex |
| `packages/opencode/src/tool/registry.ts` | Tool registration, `fromPlugin()`, `Plugin.trigger("tool.definition")` |
| `packages/plugin/src/index.ts` | Plugin type definitions, all available hooks |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` | SDK client classes |

## Decisions and their reasoning

1. **Session.permission over permission table** — Session-scoped, doesn't leak to other sessions or survive beyond the session. The permission table is project-scoped and would affect all sessions in the project.

2. **No process.chdir()** — It's process-global (affects all sessions), and `tool.execute.before` already injects `workdir` for bash. Removed during audit.

3. **No Instance.dispose() / config update** — DB write alone is sufficient because moving to a new project means `PermissionNext.state()` loads fresh for that project. No reload needed.

4. **Global sessions CAN move to git repos** — The source doesn't need to be a git repo. Only the target does, because we need a real project_id. Moving from global to a proper project is a valid "adoption" of the session.

5. **Overrides persisted to disk** — Originally needed to survive `Instance.dispose()` reload cycles. That's no longer triggered, but persistence across restarts is still useful — if opencode restarts, the override map is recovered and tool interception continues.

6. **State files in ~/.local/share/opencode/** — Not `/tmp`. Contains session IDs and directory paths. Written with 0600 permissions.

7. **Debug logging gated behind env var** — `OPENCODE_DIR_DEBUG=1` enables logging to `~/.local/share/opencode/opencode-dir-debug.log`. Silent by default.

## Known limitations

- `Instance.directory` is immutable — the system prompt still references the original directory. After `/cd`, the agent sees the old directory in its system context but tools operate in the new one. Restarting opencode in the target directory gives a fully clean slate.
- If two sessions `/cd` to different directories, the overrides are independent (keyed by session ID), but the overrides file on disk represents all sessions. This is fine — it's a Map serialization.
- The `replaceAll(oldDir, newDir)` on bash commands is a blunt instrument — it could theoretically rewrite a path that happens to contain the old directory as a substring in a non-path context (e.g. a string literal). In practice this hasn't been an issue.
