# opencode-dir

Directory operations for [opencode](https://opencode.ai) sessions.

When working across monorepos or multiple repositories, sessions get stuck in the directory they were started in. This plugin adds `/cd` and `/mv` commands to move sessions between directories.

## Commands

### `/cd <path>`

Change the session's working directory. Updates the session metadata without rewriting message history. Useful when you want the session to continue in a new location but don't need old file references updated.

### `/mv <path>`

Move the session to a new directory. Updates the session metadata **and** rewrites `path.cwd` and `path.root` in all assistant messages to point to the new location. Use this when relocating a session and its full context to a different repo.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-dir"]
}
```

## Requirements

- The **target** directory must be inside a git repository. Moving to a non-git directory is not supported because opencode groups all non-git sessions under a single `"global"` project, making reliable moves impossible.
- Sessions started in non-git directories can be moved **into** a git repo — this is a valid way to "adopt" a global session into a proper project.

## How it works

1. Resolves the target directory and computes its project ID (the repo's initial commit hash, matching opencode's own logic)
2. Updates the session's `directory` and `project_id` in the database
3. For `/mv`, rewrites `path.cwd` and `path.root` in all assistant messages from the old directory to the new one
4. Intercepts subsequent tool calls (`bash`, `read`, `write`, `edit`, `glob`, `grep`) and rewrites file paths from the old directory to the new one — tools operate in the new directory immediately without a restart
5. Writes an `external_directory` permission rule on the session so tools can access the new directory without prompts

For a fully clean environment, restart opencode in the target directory after the move.

## License

MIT
