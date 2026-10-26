# Portable OpenCode Setup

This folder restores the OpenCode setup on another Windows PC and starts new
projects with the right scaffolding.

## What is included

- OpenCode settings: `opencode.jsonc`, `cli.json`, `AGENTS.md`
- Global memory: human and persona blocks
- Plugins:
  - `opencode-agent-memory@0.3.0` — persistent memory
  - `cc-safety-net@2.6.19` — blocks destructive commands and secret reads
- Skills:
  - Graphify (`graphify`) and its project hook
  - Nine Vercel agent skills (React, Next.js, UI, writing, deploy, optimize)
- The `skills` CLI for searching and installing new skills
- Graphify CLI installation through `uv`

The installer reads the plugin list from `config/opencode.jsonc`, so plugins you
add later are restored too. Run `update-kit.bat` after changing the setup.

`service.json`, API keys, tokens, and project-specific memory are intentionally
not copied.

## First install on a new PC

1. Install OpenCode and make sure `opencode` works in a terminal.
2. Install Node.js 22.20 or newer (for the skills CLI).
3. Install Python 3.10+ and `uv` (for Graphify).
4. Copy this whole `opencode-setup` folder to the new PC.
5. Double-click `install-opencode.bat`.

The installer backs up the existing OpenCode config first, installs the plugins,
restores the settings/memory/skills, installs the skills CLI, and installs
Graphify. Restart OpenCode afterward.

For an unattended run:

```bat
install-opencode.bat -Yes
```

Use `-DryRun` to preview without changing anything.

## New project

```bat
new-project.bat "D:\apps\MyNewApp"
```

It creates the project folder, `.opencode/plugins`, `.opencode/skills`, a
starter `README.md`, and the Graphify hook. It then asks what kind of skill the
project needs and runs the skills search.

Search for a skill without creating a project:

```bat
search-skills.bat
```

## Keep the kit current

After installing a new plugin or skill on this PC, refresh the portable copy:

```bat
update-kit.bat
```

Run it from the project that has the Graphify hook if you want that hook copied
into the kit.

## Graphify

Inside a project:

```bat
graphify .
```

Or in OpenCode:

```text
/graphify .
```

This creates `graphify-out/graph.html`, `GRAPH_REPORT.md`, and `graph.json`.
The project hook reminds OpenCode to query the graph instead of re-reading files.

## Notes

- The installer prompts before replacing the existing config and creates a
  timestamped backup in the OpenCode config folder.
- Plugins and skills execute with the permissions of your agent. Review new
  skills before using them.
- The global memory file contains personal preferences. Edit
  `config/memory/human.md` before sharing this folder with someone else.
