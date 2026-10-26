const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn, execFile } = require('child_process');
const jsonc = require('jsonc-parser');

let mainWindow = null;
let activeTerminalProc = null;

function getSetupKitPath() {
  const packagedPath = path.join(process.resourcesPath, 'setup-kit');
  if (fs.existsSync(packagedPath)) return packagedPath;
  const devPath = path.join(__dirname, 'setup-kit');
  if (fs.existsSync(devPath)) return devPath;
  return path.resolve(__dirname, '..', 'opencode-setup');
}

function getOpenCodeConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

function getStudioDataDir() {
  const dir = path.join(app.getPath('userData'), 'studio-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getKeysDir() {
  const dir = path.join(getStudioDataDir(), 'keys');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sendTerminal(text, stream = 'stdout') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('studio:terminal-data', { text, stream, ts: Date.now() });
  }
}

function execPromise(cmd, args = [], timeout = 25000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, shell: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim(),
        code: err ? err.code : 0
      });
    });
  });
}

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'OpenCode-Studio/1.0.0',
          Accept: 'application/json'
        },
        timeout: timeoutMs
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
  });
}

const PROVIDER_CATALOG = [
  {
    id: 'google',
    name: 'Google AI Studio (Gemini)',
    tier: 'Free & Paid',
    badge: 'FREE TIER AVAILABLE',
    envKey: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    baseURL: '',
    builtin: true,
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (All Free & Paid Models)',
    tier: 'Free & Paid',
    badge: '25+ FREE CODING MODELS',
    envKey: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    baseURL: 'https://openrouter.ai/api/v1',
    builtin: true,
    defaultModels: [
      'qwen/qwen3-coder:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'google/gemini-2.5-pro-exp-03-25:free',
      'meta-llama/llama-3.3-70b-instruct:free'
    ]
  },
  {
    id: 'groq',
    name: 'Groq Cloud (Ultra-Fast LPU)',
    tier: 'Free & Paid',
    badge: 'FREE DEVELOPER TIER',
    envKey: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    baseURL: 'https://api.groq.com/openai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['llama-3.3-70b-versatile', 'qwen-qwq-32b', 'deepseek-r1-distill-llama-70b']
  },
  {
    id: 'cerebras',
    name: 'Cerebras Inference',
    tier: 'Free & Paid',
    badge: 'FREE TIER AVAILABLE',
    envKey: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai/',
    baseURL: 'https://api.cerebras.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['qwen-3-coder-480b', 'llama-3.3-70b']
  },
  {
    id: 'github-models',
    name: 'GitHub Models (PAT Token)',
    tier: 'Free & Paid',
    badge: 'FREE WITH GITHUB',
    envKey: 'GITHUB_TOKEN',
    keyUrl: 'https://github.com/settings/tokens',
    baseURL: 'https://models.inference.ai.azure.com',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['gpt-4o', 'DeepSeek-R1', 'Codestral-2501']
  },
  {
    id: 'mistral',
    name: 'Mistral AI (La Plateforme / Codestral)',
    tier: 'Free & Paid',
    badge: 'FREE EXPERIMENT TIER',
    envKey: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys/',
    baseURL: 'https://api.mistral.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['codestral-latest', 'mistral-large-latest']
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude Sonnet / Opus)',
    tier: 'Paid',
    badge: 'TOP CODING PAID',
    envKey: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    baseURL: '',
    builtin: true,
    defaultModels: ['claude-sonnet-4-5', 'claude-opus-4-5']
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT / Codex)',
    tier: 'Paid',
    badge: 'PAID / PLUS',
    envKey: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    baseURL: '',
    builtin: true,
    defaultModels: ['gpt-5', 'gpt-4.1', 'o4-mini']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Platform (V3 / R1)',
    tier: 'Paid (Low Cost)',
    badge: 'ULTRA LOW COST',
    envKey: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    baseURL: 'https://api.deepseek.com/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'xai',
    name: 'xAI (Grok Coding)',
    tier: 'Paid',
    badge: 'GROK',
    envKey: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai/',
    baseURL: '',
    builtin: true,
    defaultModels: ['grok-3', 'grok-3-mini']
  },
  {
    id: 'ollama',
    name: 'Ollama (Local Offline Models)',
    tier: 'Free Local',
    badge: '100% FREE LOCAL',
    envKey: 'OLLAMA_API_KEY',
    keyUrl: 'https://ollama.com/library',
    baseURL: 'http://127.0.0.1:11434/v1',
    builtin: true,
    localNoKey: true,
    defaultModels: ['qwen2.5-coder:14b', 'qwen2.5-coder:7b', 'deepseek-coder-v2:16b']
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (Local GGUF Server)',
    tier: 'Free Local',
    badge: '100% FREE LOCAL',
    envKey: 'LMSTUDIO_API_KEY',
    keyUrl: 'https://lmstudio.ai/',
    baseURL: 'http://127.0.0.1:1234/v1',
    builtin: true,
    localNoKey: true,
    defaultModels: ['qwen2.5-coder-14b-instruct']
  }
];

const CURATED_FREE_CODING_MODELS = [
  {
    rank: 1,
    tierLabel: 'S+ Tier (Best Overall Free)',
    id: 'google/gemini-2.5-pro',
    provider: 'google',
    name: 'Gemini 2.5 Pro (Google AI Studio Free Tier)',
    context: '1,000,000',
    strengths: 'Massive 1M context, full repository reasoning, complex multi-file coding & debugging.',
    howToUse: 'Get a free API key from Google AI Studio and save under Google AI Studio.'
  },
  {
    rank: 2,
    tierLabel: 'S+ Tier (Best Open-Weights Coder)',
    id: 'openrouter/qwen/qwen3-coder:free',
    provider: 'openrouter',
    name: 'Qwen 3 Coder 480B A35B (Free via OpenRouter / Cerebras)',
    context: '262,144',
    strengths: 'Purpose-built agentic coding model, top tool-use & repo refactoring.',
    howToUse: 'Add a free OpenRouter API key or Cerebras key and select this model.'
  },
  {
    rank: 3,
    tierLabel: 'S Tier (Deep Reasoning & Architecture)',
    id: 'openrouter/deepseek/deepseek-r1:free',
    provider: 'openrouter',
    name: 'DeepSeek R1 (Free via OpenRouter / GitHub Models)',
    context: '163,840',
    strengths: 'Hard algorithm design, root-cause bug analysis, math & systems code.',
    howToUse: 'Add an OpenRouter API key and select openrouter/deepseek/deepseek-r1:free.'
  },
  {
    rank: 4,
    tierLabel: 'S Tier (Fast Daily Driver)',
    id: 'openrouter/deepseek/deepseek-chat-v3-0324:free',
    provider: 'openrouter',
    name: 'DeepSeek V3 0324 (Free via OpenRouter)',
    context: '163,840',
    strengths: 'Fast, clean code generation across TypeScript, Python, C#, GDScript, Rust.',
    howToUse: 'Add an OpenRouter API key and click Use Model.'
  },
  {
    rank: 5,
    tierLabel: 'A+ Tier (High-Speed Agentic)',
    id: 'google/gemini-2.5-flash',
    provider: 'google',
    name: 'Gemini 2.5 Flash (Google AI Studio Free Tier)',
    context: '1,000,000',
    strengths: 'High rate limits on free tier, very fast tool calling, great for long sessions.',
    howToUse: 'Add a free Google AI Studio key and select google/gemini-2.5-flash.'
  },
  {
    rank: 6,
    tierLabel: 'A+ Tier (Code Completion Specialist)',
    id: 'mistral/codestral-latest',
    provider: 'mistral',
    name: 'Mistral Codestral (Mistral Free Experiment Tier)',
    context: '256,000',
    strengths: '80+ programming languages, fast low-latency code edits and tests.',
    howToUse: 'Get a free key from console.mistral.ai and save under Mistral AI.'
  },
  {
    rank: 7,
    tierLabel: 'A Tier (Instant LPU Inference)',
    id: 'groq/llama-3.3-70b-versatile',
    provider: 'groq',
    name: 'Llama 3.3 70B Versatile (Groq Free Tier)',
    context: '128,000',
    strengths: '300+ tokens/sec on Groq LPU, instant responses for scripts and web apps.',
    howToUse: 'Get a free key from console.groq.com and save under Groq Cloud.'
  },
  {
    rank: 8,
    tierLabel: 'A Tier (Reasoning on LPU)',
    id: 'groq/qwen-qwq-32b',
    provider: 'groq',
    name: 'Qwen QwQ 32B Reasoning (Groq Free Tier)',
    context: '128,000',
    strengths: 'Strong compact reasoning model running at LPU speed.',
    howToUse: 'Save Groq API key and select groq/qwen-qwq-32b.'
  },
  {
    rank: 9,
    tierLabel: 'B+ Tier (Offline Local GPU/CPU)',
    id: 'ollama/qwen2.5-coder:14b',
    provider: 'ollama',
    name: 'Qwen 2.5 Coder 14B / 7B (Local Ollama)',
    context: '128,000',
    strengths: '100% private, zero API limits, works offline on your PC.',
    howToUse: 'Install Ollama and run: ollama pull qwen2.5-coder:14b'
  },
  {
    rank: 10,
    tierLabel: 'B Tier (Lightweight Local)',
    id: 'ollama/deepseek-coder-v2:16b',
    provider: 'ollama',
    name: 'DeepSeek Coder V2 Lite 16B MoE (Local Ollama)',
    context: '128,000',
    strengths: 'Low VRAM footprint MoE model for local offline coding.',
    howToUse: 'Install Ollama and run: ollama pull deepseek-coder-v2:16b'
  }
];

function readConfigText() {
  const cfgPath = path.join(getOpenCodeConfigDir(), 'opencode.jsonc');
  if (!fs.existsSync(cfgPath)) {
    return '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }
  return fs.readFileSync(cfgPath, 'utf8');
}

function writeConfigModify(jsonPath, value) {
  const cfgDir = getOpenCodeConfigDir();
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'opencode.jsonc');
  const current = readConfigText();
  const edits = jsonc.modify(current, jsonPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 }
  });
  const updated = jsonc.applyEdits(current, edits);
  fs.writeFileSync(cfgPath, updated, 'utf8');
}

function syncEnvFile() {
  const keysDir = getKeysDir();
  const metaPath = path.join(getStudioDataDir(), 'providers-meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
  }
  const lines = ['# Generated by OpenCode Studio - Keep private, never commit'];
  for (const [id, info] of Object.entries(meta)) {
    const keyFile = path.join(keysDir, `${id}.key`);
    if (fs.existsSync(keyFile) && info.envKey) {
      const val = fs.readFileSync(keyFile, 'utf8').trim();
      if (val) lines.push(`${info.envKey}=${val}`);
    }
  }
  const envPath = path.join(getOpenCodeConfigDir(), '.env');
  fs.mkdirSync(getOpenCodeConfigDir(), { recursive: true });
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    backgroundColor: '#0f111a',
    title: 'OpenCode Studio',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (activeTerminalProc) {
    try {
      activeTerminalProc.kill();
    } catch (_) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

function findExecutableOnPath(names) {
  const pathEnv = process.env.PATH || process.env.Path || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  dirs.push(
    path.join(os.homedir(), '.local', 'bin'),
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps'),
    'C:\\Program Files\\nodejs',
    'C:\\Program Files\\Git\\cmd'
  );
  for (const d of dirs) {
    for (const n of names) {
      const full = path.join(d, n);
      try {
        if (fs.existsSync(full)) return full;
      } catch (_) {}
    }
  }
  return null;
}

// IPC: Instant System Status & Prerequisite Detection (Zero Process Spawns = 0ms Lag)
ipcMain.handle('studio:get-status', async () => {
  const cfgDir = getOpenCodeConfigDir();
  const agentsSkillsDir = path.join(os.homedir(), '.agents', 'skills');
  const opencodeSkillsDir = path.join(cfgDir, 'skills');

  const opencodeBin = findExecutableOnPath(['opencode.exe', 'opencode.cmd', 'opencode']);
  const nodeBin = findExecutableOnPath(['node.exe']);
  const gitBin = findExecutableOnPath(['git.exe']);
  const uvBin = findExecutableOnPath(['uv.exe']);
  const pyBin = findExecutableOnPath(['python.exe', 'py.exe']);
  const graphifyBin = findExecutableOnPath(['graphify.exe', 'graphify.cmd']);
  const adbBin =
    findExecutableOnPath(['adb.exe']) ||
    (fs.existsSync('D:\\apps\\MY ai Agent\\apps\\nightwood\\buildtools\\android-sdk\\platform-tools\\adb.exe')
      ? 'D:\\apps\\MY ai Agent\\apps\\nightwood\\buildtools\\android-sdk\\platform-tools\\adb.exe'
      : null);
  const wtBin = findExecutableOnPath(['wt.exe']);

  let graphifyVer = '';
  const graphifyVerFile = path.join(opencodeSkillsDir, 'graphify', '.graphify_version');
  if (fs.existsSync(graphifyVerFile)) {
    try {
      graphifyVer = 'graphify ' + fs.readFileSync(graphifyVerFile, 'utf8').trim();
    } catch (_) {}
  } else if (graphifyBin) {
    graphifyVer = 'Installed';
  }

  let reaVersion = '';
  const appDataReaPkg = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'rea-agents', 'package.json');
  const cfgReaPkg = path.join(cfgDir, 'tools', 'rea', 'node_modules', 'rea-agents', 'package.json');
  if (fs.existsSync(appDataReaPkg)) {
    try {
      reaVersion = JSON.parse(fs.readFileSync(appDataReaPkg, 'utf8')).version;
    } catch (_) {}
  } else if (fs.existsSync(cfgReaPkg)) {
    try {
      reaVersion = JSON.parse(fs.readFileSync(cfgReaPkg, 'utf8')).version;
    } catch (_) {}
  }

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}

  const listDirs = (d) => {
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  };

  const skills = Array.from(new Set([...listDirs(opencodeSkillsDir), ...listDirs(agentsSkillsDir)])).sort();
  const plugins = Array.isArray(cfg.plugins)
    ? cfg.plugins.map((p) => (typeof p === 'string' ? p : p.package))
    : [];
  const mcpServers = cfg.mcp ? Object.keys(cfg.mcp) : [];

  const prereqs = [
    {
      id: 'opencode',
      name: 'OpenCode V2 CLI',
      category: 'Core AI Runtime',
      required: true,
      installed: Boolean(opencodeBin),
      version: opencodeBin ? 'OpenCode v2.0.22+' : 'Not installed',
      description: 'Main coding agent runtime, server, and TUI.'
    },
    {
      id: 'node',
      name: 'Node.js Runtime (22.20+ / 26.12+)',
      category: 'Core Runtime',
      required: true,
      installed: Boolean(nodeBin),
      version: nodeBin ? `Node (${nodeBin})` : 'Not installed',
      description: 'Required for OpenCode plugins, skills CLI, and REA MCP.'
    },
    {
      id: 'git',
      name: 'Git for Windows',
      category: 'Core Runtime',
      required: true,
      installed: Boolean(gitBin),
      version: gitBin ? 'Installed' : 'Not installed',
      description: 'Required for worktrees, skills cloning, and repositories.'
    },
    {
      id: 'uv',
      name: 'Python + uv Package Manager',
      category: 'Knowledge Graph',
      required: true,
      installed: Boolean(uvBin || pyBin),
      version: uvBin ? 'uv + Python Installed' : pyBin ? 'Python Installed' : 'Not installed',
      description: 'Required to install and run Graphify knowledge graphs.'
    },
    {
      id: 'graphify',
      name: 'Graphify CLI & Skill',
      category: 'Knowledge Graph',
      required: true,
      installed: Boolean(graphifyVer || graphifyBin),
      version: graphifyVer || 'Not installed',
      description: 'Builds persistent code/doc knowledge graphs for fast agent queries.'
    },
    {
      id: 'rea',
      name: 'REA 6.8.0 (Reverse Engineer Anything)',
      category: 'MCP Server (229 Tools)',
      required: true,
      installed: Boolean(reaVersion),
      version: reaVersion ? `rea-agents ${reaVersion}` : 'Not installed',
      description: 'Reverse engineering & static/dynamic inspection MCP server.'
    },
    {
      id: 'adb',
      name: 'Android SDK Platform-Tools & USB Driver',
      category: 'Device Drivers & Mobile',
      required: false,
      installed: Boolean(adbBin),
      version: adbBin ? 'ADB Ready' : 'Optional (Not on PATH)',
      description: 'ADB + Fastboot + USB drivers for installing APKs to Android phones.'
    },
    {
      id: 'wt',
      name: 'Windows Terminal',
      category: 'Terminal App',
      required: false,
      installed: Boolean(wtBin),
      version: wtBin ? 'Installed' : 'Optional',
      description: 'Modern GPU-accelerated terminal for full-screen OpenCode TUI.'
    }
  ];

  return {
    appVersion: app.getVersion(),
    installPath: app.getAppPath(),
    setupKitPath: getSetupKitPath(),
    configDir: cfgDir,
    currentModel: cfg.model || 'Default (Provider Default)',
    prereqs,
    plugins,
    skills,
    mcpServers
  };
});

// IPC: Fast Zero-Process Startup Update Check via Direct HTTPS to npm registry
ipcMain.handle('studio:check-updates', async () => {
  const packages = [
    { id: 'opencode-ai', label: 'OpenCode CLI' },
    { id: 'rea-agents', label: 'REA MCP Server' },
    { id: 'opencode-agent-memory', label: 'Agent Memory Plugin' },
    { id: 'cc-safety-net', label: 'CC Safety Net Plugin' },
    { id: 'skills', label: 'Vercel Skills CLI' }
  ];

  const status = await Promise.all(
    packages.map(async (pkg) => {
      try {
        const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg.id)}/latest`, 4500);
        return {
          id: pkg.id,
          label: pkg.label,
          latest: (meta && meta.version) || 'unknown'
        };
      } catch (_) {
        return { id: pkg.id, label: pkg.label, latest: 'unknown' };
      }
    })
  );

  const cfg = jsonc.parse(readConfigText()) || {};
  const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];

  const appDataReaPkg = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'rea-agents', 'package.json');
  let reaInstalled = '6.8.0';
  if (fs.existsSync(appDataReaPkg)) {
    try {
      reaInstalled = JSON.parse(fs.readFileSync(appDataReaPkg, 'utf8')).version;
    } catch (_) {}
  }

  const results = status.map((item) => {
    let current = 'installed';
    if (item.id === 'rea-agents') current = reaInstalled;
    if (item.id === 'opencode-agent-memory' || item.id === 'cc-safety-net') {
      const found = plugins.find((p) => typeof p === 'string' && p.startsWith(item.id + '@'));
      if (found) current = found.split('@')[1];
    }
    const hasUpdate =
      item.latest !== 'unknown' &&
      current !== 'installed' &&
      current !== item.latest;
    return { ...item, current, hasUpdate };
  });

  return {
    checkedAt: new Date().toISOString(),
    updatesAvailable: results.some((r) => r.hasUpdate),
    items: results
  };
});

function runStreamedProcess(command, args, cwd) {
  return new Promise((resolve) => {
    sendTerminal(`\n$ ${command} ${args.join(' ')}\n`, 'cmd');
    const child = spawn(command, args, {
      cwd: cwd || os.homedir(),
      shell: true,
      windowsHide: true
    });
    activeTerminalProc = child;
    let out = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      sendTerminal(s, 'stdout');
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      out += s;
      sendTerminal(s, 'stderr');
    });
    child.on('close', (code) => {
      if (activeTerminalProc === child) activeTerminalProc = null;
      sendTerminal(`\n[Process exited with code ${code}]\n`, 'meta');
      resolve({ ok: code === 0, code, output: out });
    });
  });
}

// IPC: Install selected prerequisites / drivers
ipcMain.handle('studio:install-prereqs', async (_event, ids = []) => {
  const results = [];
  for (const id of ids) {
    if (id === 'opencode') {
      results.push(await runStreamedProcess('npm', ['install', '-g', 'opencode-ai@latest']));
    } else if (id === 'node') {
      results.push(
        await runStreamedProcess('winget', [
          'install',
          '--id',
          'OpenJS.NodeJS.LTS',
          '-e',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ])
      );
    } else if (id === 'git') {
      results.push(
        await runStreamedProcess('winget', [
          'install',
          '--id',
          'Git.Git',
          '-e',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ])
      );
    } else if (id === 'uv') {
      results.push(
        await runStreamedProcess('winget', [
          'install',
          '--id',
          'astral-sh.uv',
          '-e',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ])
      );
    } else if (id === 'graphify') {
      results.push(await runStreamedProcess('uv', ['tool', 'install', 'graphifyy']));
      results.push(await runStreamedProcess('graphify', ['install', '--platform', 'opencode']));
    } else if (id === 'rea') {
      const appDataNpm = path.join(process.env.APPDATA || '', 'npm');
      results.push(
        await runStreamedProcess('npm', [
          'install',
          '-g',
          '--prefix',
          `"${appDataNpm}"`,
          'rea-agents@6.8.0',
          '--no-audit',
          '--no-fund'
        ])
      );
    } else if (id === 'adb') {
      results.push(
        await runStreamedProcess('winget', [
          'install',
          '--id',
          'Google.PlatformTools',
          '-e',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ])
      );
    } else if (id === 'wt') {
      results.push(
        await runStreamedProcess('winget', [
          'install',
          '--id',
          'Microsoft.WindowsTerminal',
          '-e',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ])
      );
    }
  }
  return { ok: results.every((r) => r.ok), results };
});

// IPC: Update all components (plugins, REA, Graphify, skills)
ipcMain.handle('studio:update-all', async () => {
  await runStreamedProcess('opencode', ['plugin', 'update']);
  await runStreamedProcess('uv', ['tool', 'upgrade', 'graphifyy']);
  const appDataNpm = path.join(process.env.APPDATA || '', 'npm');
  await runStreamedProcess('npm', [
    'install',
    '-g',
    '--prefix',
    `"${appDataNpm}"`,
    'rea-agents@latest',
    '--no-audit',
    '--no-fund'
  ]);
  return { ok: true };
});

// IPC: Run full kit restore
ipcMain.handle('studio:run-kit-restore', async () => {
  const script = path.join(getSetupKitPath(), 'scripts', 'install.ps1');
  return await runStreamedProcess('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `"${script}"`,
    '-Yes'
  ]);
});

// IPC: Snapshot current setup into kit
ipcMain.handle('studio:update-kit', async () => {
  const script = path.join(getSetupKitPath(), 'scripts', 'snapshot.ps1');
  return await runStreamedProcess('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `"${script}"`
  ]);
});

// IPC: New project with skill search
ipcMain.handle('studio:new-project', async (_event, payload = {}) => {
  const script = path.join(getSetupKitPath(), 'scripts', 'new-project.ps1');
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `"${script}"`,
    '-Path',
    `"${payload.path}"`,
    '-Name',
    `"${payload.name || path.basename(payload.path)}"`
  ];
  if (payload.skillQuery) {
    args.push('-SkillQuery', `"${payload.skillQuery}"`);
  } else {
    args.push('-NoSearch');
  }
  return await runStreamedProcess('powershell', args);
});

ipcMain.handle('studio:search-skills', async (_event, query) => {
  const skillsCmd = path.join(getOpenCodeConfigDir(), 'node_modules', '.bin', 'skills.cmd');
  if (fs.existsSync(skillsCmd)) {
    return await runStreamedProcess(`"${skillsCmd}"`, ['find', `"${query}"`]);
  }
  return await runStreamedProcess('npx', ['-y', 'skills@1.7.4', 'find', `"${query}"`]);
});

ipcMain.handle('studio:install-skill', async (_event, spec) => {
  const skillsCmd = path.join(getOpenCodeConfigDir(), 'node_modules', '.bin', 'skills.cmd');
  const parts = spec.trim().split(/\s+/);
  if (fs.existsSync(skillsCmd)) {
    return await runStreamedProcess(`"${skillsCmd}"`, ['add', ...parts, '-g', '-a', 'opencode', '-y', '--copy']);
  }
  return await runStreamedProcess('npx', ['-y', 'skills@1.7.4', 'add', ...parts, '-g', '-a', 'opencode', '-y', '--copy']);
});

// IPC: Providers & API Key Manager
ipcMain.handle('studio:get-providers', async () => {
  const keysDir = getKeysDir();
  const metaPath = path.join(getStudioDataDir(), 'providers-meta.json');
  let customMeta = {};
  if (fs.existsSync(metaPath)) {
    try {
      customMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
  }

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}

  const cfgProviders = cfg.providers || {};

  const merged = PROVIDER_CATALOG.map((p) => {
    const keyFile = path.join(keysDir, `${p.id}.key`);
    const hasKey = fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8').trim().length > 0;
    const cfgP = cfgProviders[p.id] || {};
    const extraModels = cfgP.models ? Object.keys(cfgP.models) : [];
    const allModels = Array.from(new Set([...(p.defaultModels || []), ...extraModels]));
    return {
      ...p,
      hasKey,
      baseURL: (cfgP.settings && cfgP.settings.baseURL) || p.baseURL || '',
      models: allModels
    };
  });

  // Include user-added custom providers
  for (const [id, pCfg] of Object.entries(cfgProviders)) {
    if (!merged.some((m) => m.id === id)) {
      const keyFile = path.join(keysDir, `${id}.key`);
      const hasKey = fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8').trim().length > 0;
      merged.push({
        id,
        name: pCfg.name || id,
        tier: 'Custom Provider',
        badge: 'CUSTOM ANY MODEL',
        envKey: (customMeta[id] && customMeta[id].envKey) || `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
        keyUrl: '',
        baseURL: (pCfg.settings && pCfg.settings.baseURL) || '',
        builtin: false,
        hasKey,
        models: pCfg.models ? Object.keys(pCfg.models) : []
      });
    }
  }

  return {
    currentModel: cfg.model || '',
    providers: merged
  };
});

ipcMain.handle('studio:save-provider', async (_event, payload) => {
  const { id, name, apiKey, baseURL, envKey, models = [], builtin } = payload;
  const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const keysDir = getKeysDir();
  const keyFile = path.join(keysDir, `${cleanId}.key`);

  if (apiKey && apiKey.trim()) {
    fs.writeFileSync(keyFile, apiKey.trim(), 'utf8');
  }

  const metaPath = path.join(getStudioDataDir(), 'providers-meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
  }
  meta[cleanId] = {
    name: name || cleanId,
    envKey: envKey || `${cleanId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
    baseURL: baseURL || ''
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  syncEnvFile();

  const catalogEntry = PROVIDER_CATALOG.find((c) => c.id === cleanId);
  const isBuiltin = builtin !== undefined ? builtin : Boolean(catalogEntry && catalogEntry.builtin);

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const existingProvider = (cfg.providers && cfg.providers[cleanId]) || {};
  const providerObj = { ...existingProvider };

  if (!isBuiltin) {
    providerObj.name = name || (catalogEntry && catalogEntry.name) || cleanId;
    providerObj.package = (catalogEntry && catalogEntry.package) || '@opencode/ai/providers/openai-compatible';
  }

  providerObj.settings = { ...(providerObj.settings || {}) };
  if (fs.existsSync(keyFile)) {
    const normalizedKeyPath = keyFile.replace(/\\/g, '/');
    providerObj.settings.apiKey = `{file:${normalizedKeyPath}}`;
  }
  if (baseURL && baseURL.trim()) {
    providerObj.settings.baseURL = baseURL.trim();
  }

  if (models.length > 0 || !isBuiltin) {
    providerObj.models = { ...(providerObj.models || {}) };
    const defaultList = (catalogEntry && catalogEntry.defaultModels) || [];
    for (const m of [...defaultList, ...models]) {
      const mClean = m.trim();
      if (mClean && !providerObj.models[mClean]) {
        providerObj.models[mClean] = { name: mClean };
      }
    }
  }

  writeConfigModify(['providers', cleanId], providerObj);
  return { ok: true, id: cleanId };
});

ipcMain.handle('studio:remove-provider', async (_event, id) => {
  const keyFile = path.join(getKeysDir(), `${id}.key`);
  if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
  writeConfigModify(['providers', id], undefined);
  syncEnvFile();
  return { ok: true };
});

ipcMain.handle('studio:set-default-model', async (_event, modelRef) => {
  writeConfigModify(['model'], modelRef.trim());
  return { ok: true, model: modelRef.trim() };
});

ipcMain.handle('studio:add-custom-model', async (_event, payload) => {
  const { providerId, modelId, displayName, baseURL, apiKey, setAsDefault } = payload;
  const pId = providerId.trim().toLowerCase();
  const mId = modelId.trim();

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}

  const catalogEntry = PROVIDER_CATALOG.find((c) => c.id === pId);
  const isBuiltin = Boolean(catalogEntry && catalogEntry.builtin);
  const existingP = (cfg.providers && cfg.providers[pId]) || {};

  if (!isBuiltin && !existingP.package) {
    existingP.name = (catalogEntry && catalogEntry.name) || pId;
    existingP.package = (catalogEntry && catalogEntry.package) || '@opencode/ai/providers/openai-compatible';
  }

  existingP.settings = { ...(existingP.settings || {}) };
  if (baseURL && baseURL.trim()) {
    existingP.settings.baseURL = baseURL.trim();
  }
  if (apiKey && apiKey.trim()) {
    const keyFile = path.join(getKeysDir(), `${pId}.key`);
    fs.writeFileSync(keyFile, apiKey.trim(), 'utf8');
    existingP.settings.apiKey = `{file:${keyFile.replace(/\\/g, '/')}}`;
    syncEnvFile();
  }

  existingP.models = { ...(existingP.models || {}) };
  existingP.models[mId] = {
    modelID: mId,
    name: (displayName && displayName.trim()) || mId
  };

  writeConfigModify(['providers', pId], existingP);
  const fullRef = `${pId}/${mId}`;
  if (setAsDefault) {
    writeConfigModify(['model'], fullRef);
  }
  return { ok: true, fullRef };
});

// IPC: Ranked Free Coding Models (Curated + Live OpenRouter Free API)
ipcMain.handle('studio:fetch-free-models', async () => {
  let liveFree = [];
  try {
    const data = await fetchJson('https://openrouter.ai/api/v1/models');
    if (data && Array.isArray(data.data)) {
      const freeRaw = data.data.filter((m) => {
        const p = m.pricing || {};
        const promptZero = p.prompt === '0' || p.prompt === 0;
        const compZero = p.completion === '0' || p.completion === 0;
        return (promptZero && compZero) || String(m.id).endsWith(':free');
      });

      const scoreModel = (m) => {
        const idName = `${m.id} ${m.name || ''} ${m.description || ''}`.toLowerCase();
        let score = 0;
        if (idName.includes('coder') || idName.includes('codestral')) score += 500;
        if (idName.includes('qwen3') || idName.includes('qwen-3') || idName.includes('qwen2.5')) score += 350;
        if (idName.includes('deepseek')) score += 340;
        if (idName.includes('gemini-2.5') || idName.includes('gemini-2.0')) score += 320;
        if (idName.includes('claude') || idName.includes('gpt-4')) score += 300;
        if (idName.includes('llama-3.3') || idName.includes('llama-4')) score += 260;
        if (idName.includes('r1') || idName.includes('qwq') || idName.includes('reasoning')) score += 180;
        score += Math.min(200, Math.round((m.context_length || 0) / 2000));
        return score;
      };

      liveFree = freeRaw
        .map((m) => ({
          id: `openrouter/${m.id}`,
          rawId: m.id,
          name: m.name || m.id,
          context: (m.context_length || 0).toLocaleString(),
          score: scoreModel(m)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 35);
    }
  } catch (_) {}

  return {
    curated: CURATED_FREE_CODING_MODELS,
    liveOpenRouter: liveFree
  };
});

// IPC: Auto-Fallback Free Model Chain (Auto-switches when usage/quota finishes)
ipcMain.handle('studio:get-fallback-chain', async () => {
  const cfgDir = getOpenCodeConfigDir();
  const chainFile = path.join(cfgDir, 'free-fallback-chain.json');
  const statusFile = path.join(cfgDir, 'free-fallback-status.json');

  let chainData = {
    enabled: true,
    cooldownMinutes: 15,
    chain: CURATED_FREE_CODING_MODELS.map((m) => m.id)
  };
  if (fs.existsSync(chainFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
      chainData = { ...chainData, ...parsed };
    } catch (_) {}
  }

  let statusData = null;
  if (fs.existsSync(statusFile)) {
    try {
      statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    } catch (_) {}
  }

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}

  return {
    ...chainData,
    currentModel: cfg.model || chainData.chain[0] || '',
    lastStatus: statusData
  };
});

ipcMain.handle('studio:save-fallback-chain', async (_event, payload) => {
  const cfgDir = getOpenCodeConfigDir();
  fs.mkdirSync(cfgDir, { recursive: true });
  const chainFile = path.join(cfgDir, 'free-fallback-chain.json');
  const cleanChain = Array.isArray(payload.chain)
    ? payload.chain.map((s) => String(s).trim()).filter(Boolean)
    : CURATED_FREE_CODING_MODELS.map((m) => m.id);

  const data = {
    enabled: payload.enabled !== false,
    cooldownMinutes: Number(payload.cooldownMinutes) || 15,
    chain: cleanChain
  };
  fs.writeFileSync(chainFile, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, ...data };
});

ipcMain.handle('studio:switch-next-free-model', async () => {
  const cfgDir = getOpenCodeConfigDir();
  const chainFile = path.join(cfgDir, 'free-fallback-chain.json');
  const statusFile = path.join(cfgDir, 'free-fallback-status.json');

  let chain = CURATED_FREE_CODING_MODELS.map((m) => m.id);
  if (fs.existsSync(chainFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
      if (Array.isArray(parsed.chain) && parsed.chain.length > 0) chain = parsed.chain;
    } catch (_) {}
  }

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}

  const currentModel = cfg.model || '';
  const idx = chain.indexOf(currentModel);
  const nextModel = chain[(idx + 1) % chain.length];

  writeConfigModify(['model'], nextModel);
  const statusObj = {
    lastSwitchAt: new Date().toISOString(),
    fromModel: currentModel || 'default',
    toModel: nextModel,
    reason: 'Quota finished / Auto-rotated to next free coding model'
  };
  fs.writeFileSync(statusFile, JSON.stringify(statusObj, null, 2), 'utf8');
  return { ok: true, ...statusObj };
});

// IPC: Embedded Terminal
ipcMain.handle('studio:terminal-run', async (_event, { cmd, cwd }) => {
  if (!cmd || !cmd.trim()) return { ok: true };
  return await runStreamedProcess(cmd, [], cwd || os.homedir());
});

ipcMain.handle('studio:terminal-stop', async () => {
  if (activeTerminalProc) {
    try {
      activeTerminalProc.kill();
      activeTerminalProc = null;
      sendTerminal('\n[Process terminated by user]\n', 'stderr');
    } catch (_) {}
  }
  return { ok: true };
});

ipcMain.handle('studio:open-external-terminal', async (_event, { cwd, cmd }) => {
  const dir = cwd || os.homedir();
  const commandText = cmd || 'opencode';
  spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', `Set-Location '${dir}'; ${commandText}`], {
    detached: true,
    windowsHide: false
  });
  return { ok: true };
});

ipcMain.handle('studio:open-path', async (_event, targetPath) => {
  await shell.openPath(targetPath);
  return { ok: true };
});

ipcMain.handle('studio:open-url', async (_event, url) => {
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('studio:pick-directory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('studio:create-desktop-shortcut', async () => {
  const desktop = app.getPath('desktop');
  const shortcutPath = path.join(desktop, 'OpenCode Studio.lnk');
  const target = process.execPath;
  const ok = shell.writeShortcutLink(shortcutPath, 'create', {
    target,
    cwd: path.dirname(target),
    description: 'OpenCode Studio - AI Agent, Skills, Plugins & Models Hub',
    icon: target,
    iconIndex: 0
  });
  return { ok, shortcutPath };
});
