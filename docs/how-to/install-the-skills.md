# How to install the gsd-atlas skills

This guide gives your agent the Agent Skills that ship with gsd-atlas. It assumes a clone of gsd-atlas or an installed package, and Claude Code. `gsd-atlas init` registers the MCP server and copies no skills, so installing a skill is a step of its own.

The skills in the package:

| Skill | What it is for |
| --- | --- |
| `gsd-atlas` | Use gsd-atlas before searching a repository for code by name, before editing a function, class or type, and when asked who calls, implements, extends or depends on something. |
| `gsd-atlas-module-author` | Walks a contributor through writing a gsd-atlas language module: the atlas-lang.json manifest, the three query files (tags.scm, refs.scm, imports.scm), fixtures with golden files, the grammar lock and the parse-error budget, using the built-in TypeScript module as the worked example. |

`gsd-atlas-module-author` is marked `disable-model-invocation: true` in its front matter. Each skill is one folder with a `SKILL.md`.

1. Find the skills. They ship inside the package under `skills/`; in a clone they are in the repository's `skills/` folder.

2. Copy the folder of the skill you want to your personal skills folder. Claude Code reads a personal skill from `~/.claude/skills/<skill name>/SKILL.md`:

   ```sh
   mkdir -p ~/.claude/skills
   cp -R /path/to/gsd-atlas/skills/gsd-atlas ~/.claude/skills/gsd-atlas
   ```

3. Start a new Claude Code session, so that it loads the skill.

## If you want to load the skill for one run only

Claude Code loads a plugin directory with `--plugin-dir`, so a headless run needs no copy into your skills folder. Make a folder with a manifest and the skill:

```sh
mkdir -p /path/to/atlas-plugin/.claude-plugin /path/to/atlas-plugin/skills
cp -R /path/to/gsd-atlas/skills/gsd-atlas /path/to/atlas-plugin/skills/gsd-atlas
```

Write the manifest to `/path/to/atlas-plugin/.claude-plugin/plugin.json`:

<!-- verified-by: code: scripts/eval/arms.ts -->
```json
{
  "name": "gsd-atlas-local",
  "version": "0.0.0",
  "description": "The gsd-atlas skill."
}
```

Then start Claude Code with the folder:

```sh
claude --plugin-dir /path/to/atlas-plugin
```

The skill is listed under the plugin's name, here as `gsd-atlas-local:gsd-atlas`. The evaluation of gsd-atlas builds the same kind of folder with the plugin name `gsd-atlas-eval`, so there it loads as `gsd-atlas-eval:gsd-atlas`.

## If the agent is not Claude Code

This guide gives no folder for other agents. The skill is a `SKILL.md` file with a name and a description in its front matter; see your agent's own documentation for where it reads skills from.

## If you want the server too

The skills describe the tools of the MCP server, so register it as well: [How to register the MCP server with Claude Code, Cursor and Codex](register-the-mcp-server.md).

For what the tools return, see [the MCP reference](../reference/mcp.md).
