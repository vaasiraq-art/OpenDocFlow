<div align="center">

# OpenDocFlow v3.1 — The Unified AI Agent Gateway & Skill Hub

**Never stop coding. Route OpenCode, Claude Code, Codex, Cursor, Cline & Aider across 20+ Free & Paid AI Coding Providers with Multi-Key Pooling, Live API Key Model Scanning, Universal World Skill Harvesting & Encrypted Cloud Sync.**

[![Download Latest Windows Installer](https://img.shields.io/badge/Download_Installer-v3.1.0_.exe-e57a24?style=for-the-badge&logo=windows)](https://github.com/vaasiraq-art/OpenDocFlow/releases/latest)
[![Report Bug or Request Feature](https://img.shields.io/badge/GitHub_Issues-Report_Bug_/_PR-4772b3?style=for-the-badge&logo=github)](https://github.com/vaasiraq-art/OpenDocFlow/issues)

<br/>

<img src="./docs/preview-studio-ui.svg" alt="OpenDocFlow v3.1 AI Agent Gateway & Router UI" width="100%"/>

</div>

---

## Why OpenDocFlow?

| Capability | OpenDocFlow v3.1 | Typical Web Proxy Routers |
| :--- | :--- | :--- |
| **Startup & Install Speed** | **`0ms` local startup • Fast unpack `.exe` • `<50 MB` RAM** | Heavy 4–8 GB Node/Next.js web server |
| **In-App Guidance** | **`📘 Step-by-Step Guide` tab + Guide Banner in every tab + Instant Hover Tooltip on every button** | Complex external docs |
| **Live API Key Model Scanner** | **Paste any API key → Click `Scan Key Models` → Reads & activates all models inside your key** | Manual model ID typing |
| **Multi-Key Pooling** | **Paste multiple free keys per provider → Automatic Round-Robin Key Pool rotation** | Single key bottleneck |
| **Streaming & Protocols** | **Real SSE Streaming (`stream: true`) + OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`)** | Single protocol |
| **Non-Stop Free Failover** | **3-Layer Self-Healing Gateway (`:4141/v1`) + `free-model-autoswitch.js` V2 Plugin** | Stops mid-session on 429 |
| **Universal Skill Harvester** | **Imports skills from Claude Code, Codex, Cursor (`.cursorrules`), Windsurf, GitHub, or any Web URL** | Single-agent format only |
| **Cloud Sign-In & Sync** | **Sign in with GitHub or Google Drive → AES-256-GCM encrypted workspace sync across PCs** | Local machine only |
| **Auto Bug Reporter** | **Captures errors automatically (redacting secrets) for 1-click GitHub Issue submission** | Manual log hunting |

---

## Complete Step-by-Step User Guide (Every Feature Explained)

> **Tip inside the app:** Click the **📘 Step-by-Step Guide** tab in the top bar at any time, or hover your mouse over any button to read a live explanation in the floating tooltip and bottom status bar.

### Step 1: Install & Check Required Apps / Drivers
1. Download **`OpenDocFlow-Setup-3.1.0.exe`** from [**GitHub Releases**](https://github.com/vaasiraq-art/OpenDocFlow/releases/latest).
2. Run the installer, review the **Pre-Install Apps & Drivers Checklist**, select any drive or folder (`C:`, `D:`, `E:`, `F:`), and launch **OpenDocFlow** from your Desktop shortcut.
3. Click the **Apps & Drivers** tab in the top bar:
   - Click **Select Missing** to highlight any missing component (`OpenCode V2`, `Node.js`, `Git`, `Python + uv`, `Graphify`, `REA 6.8.0`, or `Android ADB USB Drivers`).
   - Click **Install Selected Apps / Drivers** — installation streams live in the bottom console.

### Step 2: Add API Keys & Scan All Models Inside Your Key
1. Click the **AI Keys & Scanner** tab in the top bar.
2. To get a free key, click **Get Key** on any provider card (**Google AI Studio**, **OpenRouter**, **Groq**, **Cerebras**, **SambaNova**, **Chutes**, **Mistral**, **GitHub Models**, **NVIDIA NIM**, **Kimi**, **Z.ai**).
3. Paste **1 key or multiple keys** (one per line for **Multi-Key Pooling**).
4. Click **🔍 Scan Key** (or **🔍 Scan & Read All Models in My API Key** at the top):
   - OpenDocFlow connects to the provider's live `/models` endpoint using your key, discovers every model unlocked by your key, and displays them as clickable chips.
   - Click any discovered model chip to make it your active coding model immediately!

### Step 3: Browse Free Coding Models & Enable Non-Stop Auto-Switch
1. Click the **Free Models (Best → Low)** tab to view the top 12 curated free coding tiers (`S+ Tier` → `B Tier`) plus live `$0` free models fetched from OpenRouter.
2. Click **Use Model** on any row to select it, or click **⚡ Use Smart Gateway in OpenCode** on the left shelf.
3. Click the **Combo Router** tab to view or reorder your fallback chain:
   - Make sure **Auto-Switch on Quota Finish** is checked.
   - When Model #1 hits its rate limit or quota (`HTTP 429` / `402`), OpenDocFlow rotates across your key pool and automatically switches to Model #2, #3, etc. so your coding session never stops.

### Step 4: Import Any Skill or Plugin from Anywhere in the World
1. Click the **World Skills & Plugins** tab in the top bar.
2. Click **⇄ Sync All Skills on PC** to automatically unify all skills installed across **Claude Code**, **OpenAI Codex**, **Gemini**, and **OpenCode**.
3. To import a skill from any website or repository:
   - Paste any GitHub repo (`owner/repo`), any direct URL (`SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.mdc`), or raw prompt text.
   - Click **★ Import & Convert Skill for All Agents** — the app converts it into standard format and installs it across all your coding agents.
4. To install any OpenCode plugin:
   - Enter the npm package name, GitHub URL, or file path under **Universal Plugin Installer** and click **Install Plugin** (includes an automatic V1→V2 compatibility bridge).

### Step 5: Sign In (GitHub / Google) & Sync Your Work Across PCs
1. Click the **Cloud Sync** tab in the top bar (or the **Sign In** pill at the top right).
2. Sign in with **GitHub** (syncs to a private secret GitHub Gist on your account) or **Google** (syncs to your Google Drive / OneDrive folder).
3. Enter an optional **Encryption Passphrase** to encrypt your API keys using **PBKDF2 + AES-256-GCM**.
4. Click **☁ Save Work to Cloud Now** on your first PC, and click **⬇ Restore Work from Cloud** on your second PC to restore your entire setup in 1 click.

### Step 6: Start Projects, Connect All IDEs & Report Bugs
1. **Create a New Project:** In **Gateway Overview**, click **Browse…** to pick a folder on any drive (`C:`, `D:`, `E:`, `F:`), enter a skill topic (e.g. `godot`, `react`, `python`), and click **Create Project & Find Skill**.
2. **Connect All IDEs:** Click **🔗 Connect All IDEs (:4141/v1)** on the left shelf to route **OpenCode V2**, **Claude Code** (`/v1/messages`), **Codex**, **Cursor**, **Cline**, and **Aider** (`/v1/chat/completions`) through the local streaming gateway.
3. **Report Bugs:** Open the **Bug Reporter** tab to view any auto-captured error (with API keys automatically redacted) and click **🐞 Send Issue to GitHub Repo Now** to submit it to `vaasiraq-art/OpenDocFlow/issues`.

---

## Build from Source (For Developers)

```bat
git clone https://github.com/vaasiraq-art/OpenDocFlow.git
cd OpenDocFlow
npm install
npm start
```

Build the Windows NSIS `.exe` Installer:
```bat
npm run dist
```

---

## License & Community Contributions

Licensed under the **OpenDocFlow Community & Maintainer-Deployed License (`LICENSE`)**:
- **Download & Use:** Free for everyone to download, install, and use.
- **Auto Bug Reports & Issues:** Users and coders can submit bug reports via the in-app **Bug Reporter** or [GitHub Issues](https://github.com/vaasiraq-art/OpenDocFlow/issues).
- **Edit & Contribute:** Coders may fork and edit the code locally and open Pull Requests; official releases and deployments on GitHub are reviewed and published by **@vaasiraq-art**.
