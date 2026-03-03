# opencode-dir

Directory operations for [opencode](https://opencode.ai) sessions.

When working across monorepos or multiple repositories, sessions get stuck in the directory they were started in. This plugin adds `/cd` and `/mv` commands to move sessions between directories at runtime.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-dir"]
}
```

## Commands

### `/cd <path>`

Change the session's working directory. Tools (`bash`, `glob`, `grep`, `read`, `write`, `edit`) will operate in the new directory immediately. Message history is left untouched.

### `/mv <path>`

Same as `/cd`, but also rewrites `path.cwd` and `path.root` in all existing assistant messages to point to the new directory. Use this when you want the full conversation history to reflect the new location.

## After moving

The session is fully operational in the new directory — system prompt, tools, and permissions are all updated immediately. When you next open opencode from the target directory, the session will appear under that project's session list.

## License

MIT
