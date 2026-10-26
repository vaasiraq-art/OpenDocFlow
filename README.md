# OpenCode Studio (v1.0.0)

All-in-one Windows desktop application and portable installer for **OpenCode V2**, bundling all skills, plugins, **REA 6.8.0 (229 MCP tools)**, **Graphify 0.9.95**, **Auto-Fallback Free Model Rotation**, **Universal AI API Key Manager**, and an **Embedded Terminal**.

## Installer & Executable Paths

- **Shareable Windows Installer (`.exe`)**:
  `D:\apps\MY ai Agent\apps\opencode-studio\dist\OpenCode Studio Setup 1.0.0.exe`
  - Shows a **Pre-Install Checklist** of required apps & device drivers before installing.
  - Lets you choose any drive or folder (`C:`, `D:`, `E:`, `F:`, etc.).
  - Automatically creates the **OpenCode Studio** icon on your Desktop and Start Menu.
- **Ready-to-Run Unpacked App (`.exe`)**:
  `D:\apps\MY ai Agent\apps\opencode-studio\dist\win-unpacked\OpenCode Studio.exe`

## Key Features

1. **Startup Update & Driver Check**:
   - Every time you open the app from the Desktop icon, it checks for updates to OpenCode, REA, Agent Memory, CC Safety Net, Graphify, and Skills CLI, and asks if you want to update or install missing apps/drivers.
2. **Pre-Install Apps & Drivers Wizard**:
   - One-click checkboxes to install or repair OpenCode V2, Node.js LTS, Git, Python + `uv`, Graphify, REA 6.8.0, Android SDK Platform-Tools (ADB/Fastboot), and Windows Terminal.
3. **Auto-Switch Free Coding Models When Quota Finishes (`free-model-autoswitch.js`)**:
   - Hooks into OpenCode V2 (`http.response` and `retry`). When the active free model hits an HTTP `429` rate-limit or finishes its free usage quota, OpenCode automatically switches to the next free coding model in your ranked list (`Best → Low`) and retries the step so work on your project never stops.
4. **Universal AI API Key Manager (Free, Paid, Local & Any Custom Model)**:
   - Supports Google AI Studio (Gemini Free/Paid), OpenRouter (25+ Free Coding Models), Groq Free LPU, Cerebras Free, GitHub Models, Mistral (Codestral Free), Anthropic, OpenAI, DeepSeek, xAI, Ollama (100% Free Local), LM Studio, and any custom OpenAI-compatible provider/model.
   - Saves keys privately to `%APPDATA%\OpenCode Studio\studio-data\keys\` and `~/.config/opencode/.env` (using `{file:...}` in `opencode.jsonc` so keys are never hardcoded).
5. **Ranked Free AI Coding Models (Best → Low)**:
   - Curated `S+ → B` coding tier list plus live `$0` free models fetched from the OpenRouter API, with one-click **Use Model** activation.
6. **Embedded Terminal Console**:
   - Run PowerShell, OpenCode, REA, Graphify, and skill searches right inside the bottom terminal dock, or pop out a full-screen TUI window.

## Commands to Run or Rebuild

```bat
cd "D:\apps\MY ai Agent\apps\opencode-studio"
npm start
```

Or launch the built executable directly:

```bat
"D:\apps\MY ai Agent\apps\opencode-studio\dist\win-unpacked\OpenCode Studio.exe"
```

To rebuild the `.exe` installer after changes:

```bat
cd "D:\apps\MY ai Agent\apps\opencode-studio"
npm run dist
```
