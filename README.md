# OpenCode Studio v2.0 — Blender Workspace Edition

**The All-in-One Native AI Coding Gateway, Universal World Skill/Plugin Harvester, Auto-Fallback Router & Desktop Control Center for OpenCode V2.**

- **Download Latest Windows Installer (`.exe`):** [GitHub Releases](https://github.com/vaasiraq-art/opencode-studio/releases)
- **Report Bugs / Request Features:** [GitHub Issues](https://github.com/vaasiraq-art/opencode-studio/issues)

---

## Why OpenCode Studio v2.0?

| Capability | OpenCode Studio v2.0 | Typical Web Proxy Routers |
| :--- | :--- | :--- |
| **Startup & RAM Footprint** | **`0ms` local check • `<50 MB` native gateway** | Heavy 4–8 GB Node/Next.js server |
| **User Interface** | **Blender 4.x Dark Studio Workspace** (Topbar Tabs, Outliner, Shader Node Graph, Inspector, Console) | Cluttered multi-page web dashboard |
| **Local Smart AI Gateway** | **`http://127.0.0.1:4141/v1`** (OpenAI-compatible `/v1/chat/completions` & `/v1/models`) | Requires external daemon setup |
| **3-Layer Self-Healing Failover** | **Provider Circuit Breaker + Key Cooldown + Per-Model Quota Lockout (`HTTP 429`/`402`/`503`)** | Manual key rotation or dropped turns |
| **OpenCode V2 Native Plugin** | **Bundled `free-model-autoswitch.js` V2 hook (`http.response` + `retry`)** | Legacy V1 only |
| **Universal World Skill Harvester** | **Imports skills from Claude Code, Codex, Cursor (`.cursorrules`), Windsurf, GitHub, or ANY Web URL** | Single-agent format only |
| **Universal Plugin Bridge** | **Native OpenCode V2 plugins + automatic V1→V2 compatibility wrapper** | Breaks on V1/V2 mismatch |
| **Reverse Engineering & Graphs** | **Bundled REA 6.8.0 (229 MCP tools) + Graphify 0.9.95** | Not included |
| **Auto Bug Catcher & Reporter** | **Built-in runtime/command error catcher with 1-click redacted GitHub Issue submission** | Manual log hunting |

---

## Key Features

### 1. Blender 4.x Dark Studio UI
Designed after **Blender's** iconic dark workspace (`#181818` Topbar, `#1d1d1d` Shader-Node Viewport, `#282828` Outliner & Properties Inspector, and `#141414` Bottom Console Dock):
- **Layout & Node Router:** Visual node pipeline showing `Client Input (:4141/v1)` ➔ `Token Optimizer` ➔ `Smart Combo Router` ➔ `Free Tier Pool`.
- **Zero Lag:** Uses `0ms` pure-JS filesystem/PATH inspection and non-blocking background HTTPS registry checks.

### 2. Non-Stop Free Coding (Auto-Switch When Quota Finishes)
- **Dual-Layer Protection:**
  1. `free-model-autoswitch.js` (OpenCode V2 plugin) intercepts `429` / `402` / `503` and quota errors mid-session and automatically calls `ctx.session.switchModel(...)` to switch to the next ranked free coding model.
  2. Built-in **Smart Local Gateway (`http://127.0.0.1:4141/v1`)** routes across your connected free/paid/local providers (`smart-coding`, `priority`, `lkgp`, `round-robin`) and strips redundant ANSI/whitespace noise from large tool outputs to save 15%–70% tokens.

### 3. Universal World Skill & Plugin Harvester
- Import skills from **any agent or website in the world**:
  - Paste any GitHub repo (`owner/repo`), raw web URL (`SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.mdc`), or raw prompt text.
  - Automatically normalizes and installs into **OpenCode**, **Claude Code** (`~/.claude/skills`), **Codex** (`~/.codex/skills`), and **Gemini** (`~/.gemini/config/skills`).
- **1-Click Cross-Agent Sync:** Unifies every skill already installed on your PC across all coding agents.
- **Universal Plugin Installer:** Installs native OpenCode V2 plugins and auto-generates V2 compatibility bridges for custom or legacy plugins.

### 4. Auto-Bug Catcher & 1-Click GitHub Issue Reporter
- Automatically captures runtime exceptions and command failures (redacting all API keys and tokens).
- Submit issues directly to [`vaasiraq-art/opencode-studio/issues`](https://github.com/vaasiraq-art/opencode-studio/issues) from inside the **Bug Reporter** tab so bugs can be fixed and deployed quickly.

---

## Run & Build Commands

```bat
git clone https://github.com/vaasiraq-art/opencode-studio.git
cd opencode-studio
npm install
npm start
```

Build the Windows NSIS `.exe` Installer (`dist\OpenCode Studio Setup 2.0.0.exe`):

```bat
npm run dist
```

---

## License & Contribution Policy

Licensed under the **OpenCode Studio Community & Maintainer-Deployed License (`LICENSE`)**:
- **Download & Use:** Free for everyone to download, install, and use.
- **Issues & Bug Reports:** Users and coders can send bug reports and feature requests via the in-app **Bug Reporter** or [GitHub Issues](https://github.com/vaasiraq-art/opencode-studio/issues).
- **Edit & Contribute:** Coders may fork and edit the code locally and submit Pull Requests; all official deployments and `.exe` releases on GitHub are reviewed and published by **@vaasiraq-art**.
