# opencode-dir

Directory operations for [opencode](https://opencode.ai) sessions — change directory, move sessions, and grant access to additional directories at runtime.

When working across monorepos or multiple repositories, sessions get stuck in the directory they were started in. This plugin adds `/cd`, `/mv`, and `/add-dir` commands to manage directory context without restarting.

## Setup

Run the install script:

```bash
curl -fsSL https://raw.githubusercontent.com/adiled/opencode-dir/main/install | bash
```

Or install manually:

1. Add to `opencode.json`:
```json
{
  "plugin": ["opencode-dir"]
}
```

2. Restart opencode — the plugin auto-installs commands on first load.

## Commands

### `/cd <path>`

Change the session's working directory. Tools (`bash`, `glob`, `grep`, `read`, `write`, `edit`) will operate in the new directory immediately. Message history is left untouched.

### `/mv <path>`

Same as `/cd`, but also rewrites `path.cwd` and `path.root` in all existing assistant messages to point to the new directory. Use when you want the full conversation history to reflect the new location.

### `/add-dir <path>`

Grant tool access to an additional directory without changing the session's working directory. Use when you need to read or write files in a secondary project or monorepo package. Can be called multiple times to add several directories.

## After moving

The session is fully operational in the new directory — system prompt, tools, and permissions are all updated immediately. When you next open opencode from the target directory, the session will appear under that project's session list.

## License

MIT