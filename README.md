# opencode-dir

Directory operations for [opencode](https://opencode.ai) sessions. Change directory, move sessions, and grant access to additional directories at runtime.

When working across monorepos or multiple repositories, sessions get stuck in the directory they were started in. This plugin adds `/cd`, `/mv`, `/add-dir`, and `/remove-dir` commands to manage directory context without restarting.

## Setup

Add to `opencode.json`:
```json
{
  "plugin": ["opencode-dir"]
}
```

Add to `tui.json` for the footer pill (optional but recommended):
```json
{
  "plugin": ["opencode-dir"]
}
```

Restart opencode. The plugin auto-installs commands on first load. The TUI footer shows `parent/name:branch` + `• OpenCode` + `+N add-dir` stacked, live per session.

## Commands

### `/cd <path>`

Change the session's working directory. Tools (`bash`, `glob`, `grep`, `read`, `write`, `edit`) will operate in the new directory immediately. Message history is left untouched.

### `/mv <path>`

Same as `/cd`, but also rewrites `path.cwd` and `path.root` in all existing assistant messages to point to the new directory. Use when you want the full conversation history to reflect the new location.

### `/add-dir <path>`

Grant tool access to an additional directory without changing the session's working directory. Use when you need to read or write files in a secondary project or monorepo package. Can be called multiple times to add several directories.

### `/remove-dir <path>`

Revoke tool access to a directory previously granted via `/add-dir`. The session working directory is unchanged; only the permission entries for the given path are removed.

### `/vault <init|open|close> <path>` (directories only)

Encrypted at rest, session-scoped. `init` encrypts `<dir>` to `<dir>.age` and wipes plain. `open` decrypts to `/tmp/vault-<sessionID>` and grants that session `add-dir` access (WAL atomic). `close` re-encrypts if changed and wipes `/tmp`. Use `VAULT_PASS` env or default; key in OS keychain. Only that session can use the open vault; auto-close on session end/idle.

```bash
/vault init ~/secrets
/vault open ~/secrets
# agent works in /tmp/vault-<sessionID>
/vault close ~/secrets
```

## After moving

The session is fully operational in the new directory. System prompt, tools, and permissions are all updated immediately. When you next open opencode from the target directory, the session will appear under that project's session list.

## License

MIT