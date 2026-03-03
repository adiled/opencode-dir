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

The target must be inside a git repository.

### `/mv <path>`

Same as `/cd`, but also rewrites `path.cwd` and `path.root` in all existing assistant messages to point to the new directory. Use this when you want the full conversation history to reflect the new location.

## After moving

For a fully clean environment (updated system prompt, fresh project context), restart opencode in the target directory. The session will appear under the target project's session list.

## License

MIT
