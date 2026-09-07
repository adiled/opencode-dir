# opencode-dir

Directory operations for [opencode](https://opencode.ai) sessions. Change directory, move sessions, and grant access to additional directories at runtime.

In OpenCode, when working across monorepos or multiple repositories, sessions get stuck in the directory they were started in. **opencode-dir** plugin helps by unlocking multiple directory workflows, with special commands: `/cd`, `/mv`, `/add-dir`, `/remove-dir`.

To encrypt certain directories, use `/vault init <dir>`, and give deliberate access using `/vault open <dir>`. 

<center><img width="373" height="162" alt="Screenshot 2026-09-07 at 8 05 39 PM" src="https://github.com/user-attachments/assets/df0a907d-9da6-4e8d-b17f-60592b5ebce4" /></center>

## Setup

Add to `opencode.json` and `tui.json`, and restart OpenCode:
```json
{
  "plugin": ["opencode-dir"]
}
```

## Commands

### `/cd <path>`

Change the session's working directory. Tools (`bash`, `glob`, `grep`, `read`, `write`, `edit`) will operate in the new directory immediately. Message history is left untouched.

### `/mv <path>`

Same as `/cd`, but also rewrites `path.cwd` and `path.root` in all existing assistant messages to point to the new directory. Use when you want the full conversation history to reflect the new location.

**After moving,** the session is fully operational in the new directory. System prompt, tools, and permissions are all updated immediately. When you next open opencode from the target directory, the session will appear under that project's session list.

### `/add-dir <path>`

Grant tool access to an additional directory without changing the session's working directory. Use when you need to read or write files in a secondary project or monorepo package. Can be called multiple times to add several directories.

### `/remove-dir <path>`

Revoke tool access to a directory previously granted via `/add-dir`. The session working directory is unchanged; only the permission entries for the given path are removed.

### `/vault <init|open|close> <path>`

Encrypt a directory using a passphrase or env `OPENCODE_DIR_VAULT_PASS`. `init` to set passphrase. `init <path>` to encrypt. `open <path>` to create a temporary access for that session. `close` to revoke access on-demand.

```bash
/vault init
/vault init ~/secrets
/vault open ~/secrets
/vault close ~/secrets
```

## License

MIT
