const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const jsonc = require('jsonc-parser');

// Disable Chromium GPU/DawnGraphite shader compiler to eliminate Black Screen & "Not Responding" on low-end PCs
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const GITHUB_REPO = 'vaasiraq-art/OpenDocFlow';
const GATEWAY_PORT = 4141;

let mainWindow = null;
let activeTerminalProc = null;
let gatewayServer = null;

const gatewayState = {
  running: false,
  port: GATEWAY_PORT,
  endpoint: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
  strategy: 'smart-coding',
  compressionEnabled: true,
  promptCacheEnabled: true,
  autoBugReport: true,
  requestsTotal: 0,
  cacheHits: 0,
  failoversSaved: 0,
  tokensSaved: 0,
  avgLatencyMs: 0,
  lastGoodModel: null,
  roundRobinIndex: 0,
  keyPoolIndices: {},
  circuitBreakers: {},
  keyCooldowns: {},
  modelLockouts: {},
  recentEvents: []
};

const promptMemoryCache = new Map();

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

function getTelemetryFilePath() {
  return path.join(getStudioDataDir(), 'gateway-telemetry.json');
}

function loadPersistedTelemetry() {
  try {
    const f = getTelemetryFilePath();
    if (fs.existsSync(f)) {
      const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
      gatewayState.requestsTotal = Number(saved.requestsTotal) || 0;
      gatewayState.cacheHits = Number(saved.cacheHits) || 0;
      gatewayState.failoversSaved = Number(saved.failoversSaved) || 0;
      gatewayState.tokensSaved = Number(saved.tokensSaved) || 0;
      gatewayState.avgLatencyMs = Number(saved.avgLatencyMs) || 0;
      if (saved.strategy) gatewayState.strategy = saved.strategy;
    }
  } catch (_) {}
}

function savePersistedTelemetry() {
  try {
    fs.writeFileSync(
      getTelemetryFilePath(),
      JSON.stringify(
        {
          requestsTotal: gatewayState.requestsTotal,
          cacheHits: gatewayState.cacheHits,
          failoversSaved: gatewayState.failoversSaved,
          tokensSaved: gatewayState.tokensSaved,
          avgLatencyMs: gatewayState.avgLatencyMs,
          strategy: gatewayState.strategy
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (_) {}
}

function recordGatewayEvent(type, detail) {
  gatewayState.recentEvents.unshift({
    ts: new Date().toISOString(),
    type,
    detail
  });
  if (gatewayState.recentEvents.length > 40) {
    gatewayState.recentEvents.length = 40;
  }
  savePersistedTelemetry();
}

function validateSender(event) {
  if (!event || !event.senderFrame) return false;
  const url = event.senderFrame.url || '';
  return url.startsWith('file://');
}

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

function getBugLogPath() {
  return path.join(getStudioDataDir(), 'bug-reports.json');
}

function redactSecrets(text) {
  if (!text) return '';
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{25,}/g, 'AIza[REDACTED]')
    .replace(/gsk_[A-Za-z0-9_-]{20,}/g, 'gsk_[REDACTED]');
}

function loadBugReports() {
  const p = getBugLogPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) || [];
  } catch (_) {
    return [];
  }
}

function captureBugReport(title, detail, source = 'runtime') {
  try {
    const reports = loadBugReports();
    const entry = {
      id: `bug_${Date.now()}`,
      ts: new Date().toISOString(),
      title: redactSecrets(title).slice(0, 140),
      detail: redactSecrets(detail).slice(0, 4000),
      source,
      os: `${os.platform()} ${os.release()} (${os.arch()})`,
      appVersion: app.getVersion(),
      nodeVersion: process.versions.node
    };
    reports.unshift(entry);
    if (reports.length > 50) reports.length = 50;
    fs.writeFileSync(getBugLogPath(), JSON.stringify(reports, null, 2), 'utf8');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('studio:bug-captured', entry);
    }
    return entry;
  } catch (_) {
    return null;
  }
}

process.on('uncaughtException', (err) => {
  captureBugReport(`Uncaught Exception: ${err.message}`, err.stack || String(err), 'main-process');
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  const stack = reason && reason.stack ? reason.stack : String(reason);
  captureBugReport(`Unhandled Rejection: ${msg}`, stack, 'main-process');
});

function sendTerminal(text, stream = 'stdout') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('studio:terminal-data', { text, stream, ts: Date.now() });
  }
}

function fetchJsonWithHeaders(url, customHeaders = {}, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.get(
      target,
      {
        headers: {
          'User-Agent': 'OpenDocFlow/3.0.0',
          Accept: 'application/json',
          ...customHeaders
        },
        timeout: timeoutMs
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
  });
}

// ============================================================================
// EXPANDED 20+ FREE & PAID FRONTIER CODING PROVIDERS CATALOG
// ============================================================================
const PROVIDER_CATALOG = [
  {
    id: 'google',
    name: 'Google AI Studio (Gemini 2.5)',
    tier: 'Free & Paid',
    badge: 'FREE 1M CONTEXT',
    envKey: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    builtin: true,
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite-preview-06-17']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (All Free & Paid Models)',
    tier: 'Free & Paid',
    badge: '40+ FREE CODING MODELS',
    envKey: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    baseURL: 'https://openrouter.ai/api/v1',
    builtin: true,
    defaultModels: [
      'qwen/qwen3-coder:free',
      'deepseek/deepseek-r1:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'z-ai/glm-4.5-air:free',
      'moonshotai/kimi-k2:free',
      'meta-llama/llama-3.3-70b-instruct:free'
    ]
  },
  {
    id: 'groq',
    name: 'Groq Cloud (Ultra-Fast LPU)',
    tier: 'Free & Paid',
    badge: 'FREE LPU TIER',
    envKey: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    baseURL: 'https://api.groq.com/openai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: [
      'llama-3.3-70b-versatile',
      'moonshotai/kimi-k2-instruct',
      'qwen-qwq-32b',
      'deepseek-r1-distill-llama-70b'
    ]
  },
  {
    id: 'cerebras',
    name: 'Cerebras Wafer-Scale Inference',
    tier: 'Free & Paid',
    badge: 'FREE 2000 TOK/S',
    envKey: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai/',
    baseURL: 'https://api.cerebras.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['qwen-3-coder-480b', 'qwen-3-235b-a22b', 'llama-3.3-70b']
  },
  {
    id: 'sambanova',
    name: 'SambaNova Cloud (RDU Fast Free Tier)',
    tier: 'Free & Paid',
    badge: 'FREE RDU TIER',
    envKey: 'SAMBANOVA_API_KEY',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    baseURL: 'https://api.sambanova.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['DeepSeek-R1', 'DeepSeek-V3-0324', 'Qwen2.5-Coder-32B-Instruct', 'Meta-Llama-3.3-70B-Instruct']
  },
  {
    id: 'chutes',
    name: 'Chutes.ai (Serverless Open-Weights)',
    tier: 'Free & Paid',
    badge: 'FREE OPEN WEIGHTS',
    envKey: 'CHUTES_API_KEY',
    keyUrl: 'https://chutes.ai/',
    baseURL: 'https://llm.chutes.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['deepseek-ai/DeepSeek-V3-0324', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-235B-A22B']
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
    defaultModels: ['gpt-4o', 'o3-mini', 'DeepSeek-R1', 'Codestral-2501']
  },
  {
    id: 'mistral',
    name: 'Mistral AI (Codestral & Devstral)',
    tier: 'Free & Paid',
    badge: 'FREE EXPERIMENT TIER',
    envKey: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys/',
    baseURL: 'https://api.mistral.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['codestral-latest', 'devstral-small-latest', 'mistral-large-latest']
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM (Build Free Credits)',
    tier: 'Free & Paid',
    badge: 'FREE DEV CREDITS',
    envKey: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com/',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['qwen/qwen2.5-coder-32b-instruct', 'deepseek-ai/deepseek-r1', 'nvidia/llama-3.1-nemotron-ultra-253b-v1']
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot AI K2 / K3)',
    tier: 'Free Credits & Paid',
    badge: '1M CONTEXT CODER',
    envKey: 'MOONSHOT_API_KEY',
    keyUrl: 'https://platform.moonshot.ai/',
    baseURL: 'https://api.moonshot.ai/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['kimi-k2-0711-preview', 'moonshot-v1-128k']
  },
  {
    id: 'zhipu',
    name: 'Z.ai / Zhipu (GLM-4.5 Coding & Flash)',
    tier: 'Free & Paid',
    badge: 'GLM-4-FLASH FREE',
    envKey: 'ZHIPU_API_KEY',
    keyUrl: 'https://open.bigmodel.cn/',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['glm-4.5', 'glm-4-flash', 'codegeex-4']
  },
  {
    id: 'together',
    name: 'Together AI (Open-Weights Cloud)',
    tier: 'Free Credits & Paid',
    badge: 'FAST CODERS',
    envKey: 'TOGETHER_API_KEY',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    baseURL: 'https://api.together.xyz/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['Qwen/Qwen2.5-Coder-32B-Instruct', 'deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3']
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI (Ultra-Low Latency)',
    tier: 'Free Credits & Paid',
    badge: 'FIREATTENTION',
    envKey: 'FIREWORKS_API_KEY',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['accounts/fireworks/models/qwen3-235b-a22b', 'accounts/fireworks/models/deepseek-v3']
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic AI',
    tier: 'Free Credits & Paid',
    badge: 'OPEN WEIGHTS',
    envKey: 'HYPERBOLIC_API_KEY',
    keyUrl: 'https://app.hyperbolic.xyz/settings',
    baseURL: 'https://api.hyperbolic.xyz/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['Qwen/Qwen2.5-Coder-32B-Instruct', 'deepseek-ai/DeepSeek-R1']
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude 4.5 Opus / Sonnet)',
    tier: 'Paid',
    badge: 'FRONTIER CODING PAID',
    envKey: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    baseURL: 'https://api.anthropic.com/v1',
    builtin: true,
    defaultModels: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-3-7-sonnet-latest']
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-5 / GPT-4.1 / o3 / o4-mini)',
    tier: 'Paid',
    badge: 'FRONTIER PAID',
    envKey: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    baseURL: 'https://api.openai.com/v1',
    builtin: true,
    defaultModels: ['gpt-5', 'gpt-4.1', 'o3', 'o4-mini']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Official (V3.1 & R1)',
    tier: 'Paid (Ultra Low Cost)',
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
    name: 'xAI (Grok 4 & Grok 3 Coding)',
    tier: 'Paid',
    badge: 'GROK CODER',
    envKey: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai/',
    baseURL: 'https://api.x.ai/v1',
    builtin: true,
    defaultModels: ['grok-4', 'grok-3', 'grok-3-mini']
  },
  {
    id: 'ollama',
    name: 'Ollama (Local Offline GPU/CPU)',
    tier: 'Free Local',
    badge: '100% FREE OFFLINE',
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
    badge: '100% FREE OFFLINE',
    envKey: 'LMSTUDIO_API_KEY',
    keyUrl: 'http://127.0.0.1:1234/v1',
    baseURL: 'http://127.0.0.1:1234/v1',
    builtin: true,
    localNoKey: true,
    defaultModels: ['qwen2.5-coder-14b-instruct']
  }
];

const CURATED_FREE_CODING_MODELS = [
  {
    rank: 1,
    tierLabel: 'S+ Tier (Best 1M Context Architect)',
    id: 'google/gemini-2.5-pro',
    provider: 'google',
    name: 'Gemini 2.5 Pro (Google AI Studio Free Tier)',
    context: '1,000,000',
    strengths: '1M token context, full-repo architecture, complex multi-file coding & debugging.',
    howToUse: 'Add one or more free Google AI Studio keys and click Use Model.'
  },
  {
    rank: 2,
    tierLabel: 'S+ Tier (Best Open-Weights Agentic Coder)',
    id: 'openrouter/qwen/qwen3-coder:free',
    provider: 'openrouter',
    name: 'Qwen 3 Coder 480B A35B (Free via OpenRouter / Cerebras)',
    context: '262,144',
    strengths: 'Purpose-built agentic coding model, top tool-use & repo refactoring.',
    howToUse: 'Add a free OpenRouter or Cerebras key and click Use Model.'
  },
  {
    rank: 3,
    tierLabel: 'S+ Tier (1M Context Agentic Coder)',
    id: 'openrouter/moonshotai/kimi-k2:free',
    provider: 'openrouter',
    name: 'Kimi K2 1T MoE (Free via OpenRouter / Groq)',
    context: '131,072',
    strengths: 'Moonshot AI 1T-parameter MoE built specifically for agentic tool use & coding.',
    howToUse: 'Add an OpenRouter or Groq key and click Use Model.'
  },
  {
    rank: 4,
    tierLabel: 'S Tier (Deep Reasoning & Systems Code)',
    id: 'openrouter/deepseek/deepseek-r1:free',
    provider: 'openrouter',
    name: 'DeepSeek R1 (Free via OpenRouter / SambaNova / Chutes)',
    context: '163,840',
    strengths: 'Root-cause bug hunting, complex algorithms, C++/Rust/systems engineering.',
    howToUse: 'Add an OpenRouter, SambaNova, or Chutes key and click Use Model.'
  },
  {
    rank: 5,
    tierLabel: 'S Tier (Fast Full-Stack Daily Driver)',
    id: 'openrouter/deepseek/deepseek-chat-v3-0324:free',
    provider: 'openrouter',
    name: 'DeepSeek V3 0324 (Free via OpenRouter / Chutes)',
    context: '163,840',
    strengths: 'Clean, fast full-stack code generation across TS, Python, C#, GDScript.',
    howToUse: 'Add an OpenRouter key and click Use Model.'
  },
  {
    rank: 6,
    tierLabel: 'S Tier (Agentic Full-Stack Coder)',
    id: 'openrouter/z-ai/glm-4.5-air:free',
    provider: 'openrouter',
    name: 'GLM-4.5 Air / Flash (Free via OpenRouter / Z.ai)',
    context: '131,072',
    strengths: 'High-speed UI & web application generation with native tool calling.',
    howToUse: 'Add an OpenRouter or Z.ai key and click Use Model.'
  },
  {
    rank: 7,
    tierLabel: 'A+ Tier (High-Speed 1M Agentic)',
    id: 'google/gemini-2.5-flash',
    provider: 'google',
    name: 'Gemini 2.5 Flash (Google AI Studio Free Tier)',
    context: '1,000,000',
    strengths: 'Generous free rate limits, ultra-fast tool execution, long sessions.',
    howToUse: 'Add a free Google AI Studio key and click Use Model.'
  },
  {
    rank: 8,
    tierLabel: 'A+ Tier (2000 tok/s Wafer-Scale)',
    id: 'cerebras/qwen-3-coder-480b',
    provider: 'cerebras',
    name: 'Qwen 3 Coder 480B (Cerebras Free Tier)',
    context: '128,000',
    strengths: 'Instant full-file generation at 2,000+ tokens/sec on Cerebras hardware.',
    howToUse: 'Add a free Cerebras key and click Use Model.'
  },
  {
    rank: 9,
    tierLabel: 'A+ Tier (80+ Languages & Diffs)',
    id: 'mistral/codestral-latest',
    provider: 'mistral',
    name: 'Mistral Codestral 25.01 & Devstral (Mistral Free Tier)',
    context: '256,000',
    strengths: '256K context, fast code edits, diffs, and unit test generation.',
    howToUse: 'Add a free Mistral AI key and click Use Model.'
  },
  {
    rank: 10,
    tierLabel: 'A Tier (Instant LPU Inference)',
    id: 'groq/llama-3.3-70b-versatile',
    provider: 'groq',
    name: 'Llama 3.3 70B Versatile (Groq Free Tier)',
    context: '128,000',
    strengths: '300+ tokens/sec on Groq LPU, zero-wait responses for web & scripts.',
    howToUse: 'Add a free Groq key and click Use Model.'
  },
  {
    rank: 11,
    tierLabel: 'A Tier (RDU Fast Free Inference)',
    id: 'sambanova/Qwen2.5-Coder-32B-Instruct',
    provider: 'sambanova',
    name: 'Qwen 2.5 Coder 32B Instruct (SambaNova Free Tier)',
    context: '128,000',
    strengths: 'High-accuracy 32B coder running on SambaNova RDU hardware.',
    howToUse: 'Add a free SambaNova key and click Use Model.'
  },
  {
    rank: 12,
    tierLabel: 'B+ Tier (100% Offline Local GPU/CPU)',
    id: 'ollama/qwen2.5-coder:14b',
    provider: 'ollama',
    name: 'Qwen 2.5 Coder 14B / 7B (Local Ollama)',
    context: '128,000',
    strengths: 'Zero API limits, 100% private offline fallback when internet/quotas finish.',
    howToUse: 'Run: ollama pull qwen2.5-coder:14b'
  }
];

let cachedConfigText = null;
let cachedConfigTime = 0;

function readConfigText() {
  const now = Date.now();
  if (cachedConfigText !== null && now - cachedConfigTime < 4000) {
    return cachedConfigText;
  }
  const cfgPath = path.join(getOpenCodeConfigDir(), 'opencode.jsonc');
  if (!fs.existsSync(cfgPath)) {
    cachedConfigText = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  } else {
    cachedConfigText = fs.readFileSync(cfgPath, 'utf8');
  }
  cachedConfigTime = now;
  return cachedConfigText;
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
  cachedConfigText = updated;
  cachedConfigTime = Date.now();
}

// Supports Multi-Key Pooling: a .key file can hold 1 key or multiple keys (one per line)
function readProviderKeyPool(providerId) {
  const keyFile = path.join(getKeysDir(), `${providerId}.key`);
  if (!fs.existsSync(keyFile)) return [];
  return fs
    .readFileSync(keyFile, 'utf8')
    .split(/\r?\n|,/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function pickKeyFromPool(providerId) {
  const pool = readProviderKeyPool(providerId);
  if (pool.length === 0) return '';
  const idx = (gatewayState.keyPoolIndices[providerId] || 0) % pool.length;
  gatewayState.keyPoolIndices[providerId] = idx + 1;
  return pool[idx];
}

function syncEnvFile() {
  const metaPath = path.join(getStudioDataDir(), 'providers-meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
  }
  const lines = ['# Generated by OpenDocFlow v3.0 - Keep private, never commit'];
  for (const [id, info] of Object.entries(meta)) {
    const pool = readProviderKeyPool(id);
    if (pool.length > 0 && info.envKey) {
      lines.push(`${info.envKey}=${pool[0]}`);
    }
  }
  const envPath = path.join(getOpenCodeConfigDir(), '.env');
  fs.mkdirSync(getOpenCodeConfigDir(), { recursive: true });
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

// ============================================================================
// STREAMING + MULTI-PROTOCOL + KEY-POOLING SMART GATEWAY (:4141/v1)
// Supports OpenAI (/v1/chat/completions) AND Anthropic (/v1/messages) + SSE
// ============================================================================
function compressMessagesPayload(bodyObj) {
  if (!gatewayState.compressionEnabled || !bodyObj || !Array.isArray(bodyObj.messages)) {
    return { bodyObj, savedChars: 0 };
  }
  let savedChars = 0;
  const compressed = bodyObj.messages.map((msg) => {
    if (typeof msg.content === 'string' && msg.content.length > 1000 && (msg.role === 'tool' || msg.role === 'user')) {
      const origLen = msg.content.length;
      const cleaned = msg.content
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/[ \t]{3,}/g, '  ')
        .replace(/\n{4,}/g, '\n\n');
      savedChars += Math.max(0, origLen - cleaned.length);
      return { ...msg, content: cleaned };
    }
    return msg;
  });
  return { bodyObj: { ...bodyObj, messages: compressed }, savedChars };
}

function getConfiguredFallbackCandidates() {
  const cfgDir = getOpenCodeConfigDir();
  const chainFile = path.join(cfgDir, 'free-fallback-chain.json');
  let chain = CURATED_FREE_CODING_MODELS.map((m) => m.id);
  if (fs.existsSync(chainFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
      if (Array.isArray(parsed.chain) && parsed.chain.length > 0) chain = parsed.chain;
    } catch (_) {}
  }

  const now = Date.now();
  const candidates = [];

  for (const fullRef of chain) {
    const slash = fullRef.indexOf('/');
    if (slash === -1) continue;
    const providerId = fullRef.slice(0, slash);
    const modelId = fullRef.slice(slash + 1);

    if ((gatewayState.modelLockouts[fullRef] || 0) > now) continue;
    if ((gatewayState.keyCooldowns[providerId] || 0) > now) continue;
    const cb = gatewayState.circuitBreakers[providerId];
    if (cb && cb.openUntil > now) continue;

    const cat = PROVIDER_CATALOG.find((p) => p.id === providerId);
    const apiKey = pickKeyFromPool(providerId);

    if (!apiKey && !(cat && cat.localNoKey)) continue;
    const baseURL = (cat && cat.baseURL) || 'https://openrouter.ai/api/v1';
    candidates.push({ fullRef, providerId, modelId, apiKey, baseURL });
  }

  if (gatewayState.strategy === 'lkgp' && gatewayState.lastGoodModel) {
    candidates.sort((a, b) => (a.fullRef === gatewayState.lastGoodModel ? -1 : b.fullRef === gatewayState.lastGoodModel ? 1 : 0));
  } else if (gatewayState.strategy === 'round-robin' && candidates.length > 1) {
    const shift = gatewayState.roundRobinIndex % candidates.length;
    gatewayState.roundRobinIndex++;
    return [...candidates.slice(shift), ...candidates.slice(0, shift)];
  }
  return candidates;
}

function forwardUpstreamChat(candidate, requestBodyObj) {
  return new Promise((resolve) => {
    const targetUrl = new URL(candidate.baseURL.replace(/\/+$/, '') + '/chat/completions');
    const payload = JSON.stringify({
      ...requestBodyObj,
      model: candidate.modelId,
      stream: false
    });
    const isHttps = targetUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (candidate.apiKey) {
      headers['Authorization'] = `Bearer ${candidate.apiKey}`;
    }

    const t0 = Date.now();
    const req = lib.request(
      targetUrl,
      {
        method: 'POST',
        headers,
        timeout: 45000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const dt = Date.now() - t0;
          gatewayState.avgLatencyMs = gatewayState.avgLatencyMs
            ? Math.round(gatewayState.avgLatencyMs * 0.7 + dt * 0.3)
            : dt;
          resolve({
            status: res.statusCode || 500,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    req.on('error', (err) => {
      resolve({ status: 503, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: err.message } })) });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 504, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: 'Upstream timeout' } })) });
    });
    req.write(payload);
    req.end();
  });
}

function convertOpenAiResponseToSseStream(res, openAiJsonBuffer, routedModel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Studio-Routed-Model': routedModel
  });
  try {
    const parsed = JSON.parse(openAiJsonBuffer.toString('utf8'));
    const choice = (parsed.choices && parsed.choices[0]) || {};
    const msg = choice.message || {};
    const chunk = {
      id: parsed.id || `chatcmpl_${Date.now()}`,
      object: 'chat.completion.chunk',
      created: parsed.created || Math.floor(Date.now() / 1000),
      model: routedModel,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: msg.content || '',
            ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {})
          },
          finish_reason: choice.finish_reason || 'stop'
        }
      ]
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch (_) {
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

function translateAnthropicRequestToOpenAI(anthBody) {
  const messages = [];
  if (anthBody.system) {
    const sysText = Array.isArray(anthBody.system)
      ? anthBody.system.map((b) => b.text || '').join('\n')
      : String(anthBody.system);
    messages.push({ role: 'system', content: sysText });
  }
  for (const m of anthBody.messages || []) {
    const text = Array.isArray(m.content)
      ? m.content.map((b) => b.text || JSON.stringify(b)).join('\n')
      : String(m.content || '');
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  return {
    model: anthBody.model || 'auto-coding',
    messages,
    max_tokens: anthBody.max_tokens || 4096,
    temperature: anthBody.temperature,
    stream: false
  };
}

function translateOpenAIResponseToAnthropic(openAiBuffer, routedModel) {
  let parsed = {};
  try {
    parsed = JSON.parse(openAiBuffer.toString('utf8'));
  } catch (_) {}
  const choice = (parsed.choices && parsed.choices[0]) || {};
  const text = (choice.message && choice.message.content) || '';
  return Buffer.from(
    JSON.stringify({
      id: parsed.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: routedModel,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: (parsed.usage && parsed.usage.prompt_tokens) || 0,
        output_tokens: (parsed.usage && parsed.usage.completion_tokens) || 0
      }
    })
  );
}

function startLocalSmartGateway() {
  if (gatewayServer) return;
  loadPersistedTelemetry();

  gatewayServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gatewayState));
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      const models = [
        { id: 'auto-coding', object: 'model', owned_by: 'OpenDocFlow' },
        { id: 'auto', object: 'model', owned_by: 'OpenDocFlow' },
        { id: 'auto-fast', object: 'model', owned_by: 'OpenDocFlow' },
        { id: 'auto-fusion', object: 'model', owned_by: 'OpenDocFlow' },
        ...CURATED_FREE_CODING_MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: m.provider }))
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }

    const isAnthropicWire = req.method === 'POST' && req.url.startsWith('/v1/messages');
    const isOpenAiWire = req.method === 'POST' && req.url.startsWith('/v1/chat/completions');

    if (isOpenAiWire || isAnthropicWire) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        gatewayState.requestsTotal++;
        let rawObj = {};
        try {
          rawObj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
          return;
        }

        const clientRequestedStream = Boolean(rawObj.stream) && !isAnthropicWire;
        const openAiBody = isAnthropicWire ? translateAnthropicRequestToOpenAI(rawObj) : rawObj;

        const { bodyObj: compressedBody, savedChars } = compressMessagesPayload(openAiBody);
        if (savedChars > 0) {
          gatewayState.tokensSaved += Math.ceil(savedChars / 4);
        }

        // Check Local SHA-256 Prompt Cache for identical non-tool requests
        const cacheKey = crypto
          .createHash('sha256')
          .update(JSON.stringify(compressedBody.messages || []))
          .digest('hex');

        if (gatewayState.promptCacheEnabled && promptMemoryCache.has(cacheKey)) {
          const cached = promptMemoryCache.get(cacheKey);
          gatewayState.cacheHits++;
          recordGatewayEvent('cache-hit', `0ms Prompt Cache Hit (${cached.model})`);
          if (clientRequestedStream) {
            convertOpenAiResponseToSseStream(res, cached.body, cached.model);
          } else if (isAnthropicWire) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(translateOpenAIResponseToAnthropic(cached.body, cached.model));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Studio-Cache': 'HIT' });
            res.end(cached.body);
          }
          return;
        }

        const candidates = getConfiguredFallbackCandidates();
        if (candidates.length === 0) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: 'No eligible provider keys or local Ollama active. Add a free API key in OpenDocFlow -> AI Keys.'
              }
            })
          );
          return;
        }

        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const upstream = await forwardUpstreamChat(cand, compressedBody);

          if (upstream.status >= 200 && upstream.status < 300) {
            gatewayState.lastGoodModel = cand.fullRef;
            delete gatewayState.circuitBreakers[cand.providerId];
            if (gatewayState.promptCacheEnabled) {
              promptMemoryCache.set(cacheKey, { model: cand.fullRef, body: upstream.body });
              if (promptMemoryCache.size > 200) {
                const firstKey = promptMemoryCache.keys().next().value;
                promptMemoryCache.delete(firstKey);
              }
            }
            if (i > 0) {
              gatewayState.failoversSaved++;
              recordGatewayEvent('failover-success', `Rerouted seamlessly to ${cand.fullRef}`);
            } else {
              recordGatewayEvent('served', `Served by ${cand.fullRef} (${gatewayState.avgLatencyMs}ms)`);
            }

            if (clientRequestedStream) {
              convertOpenAiResponseToSseStream(res, upstream.body, cand.fullRef);
            } else if (isAnthropicWire) {
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'X-Studio-Routed-Model': cand.fullRef
              });
              res.end(translateOpenAIResponseToAnthropic(upstream.body, cand.fullRef));
            } else {
              res.writeHead(upstream.status, {
                'Content-Type': upstream.headers['content-type'] || 'application/json',
                'X-Studio-Routed-Model': cand.fullRef,
                'X-Studio-Strategy': gatewayState.strategy
              });
              res.end(upstream.body);
            }
            return;
          }

          // 3-Layer Self-Healing Resilience
          const now = Date.now();
          if (upstream.status === 429 || upstream.status === 402) {
            const poolSize = readProviderKeyPool(cand.providerId).length;
            if (poolSize <= 1) {
              gatewayState.modelLockouts[cand.fullRef] = now + 10 * 60 * 1000;
              gatewayState.keyCooldowns[cand.providerId] = now + 15 * 1000;
            }
            recordGatewayEvent('quota-lockout', `${cand.fullRef} hit HTTP ${upstream.status} -> rotating key/model`);
          } else if (upstream.status >= 500) {
            const prev = gatewayState.circuitBreakers[cand.providerId] || { failures: 0, openUntil: 0 };
            prev.failures++;
            if (prev.failures >= 3) prev.openUntil = now + 60 * 1000;
            gatewayState.circuitBreakers[cand.providerId] = prev;
            recordGatewayEvent('circuit-trip', `${cand.providerId} HTTP ${upstream.status} -> rerouting`);
          }
        }

        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'All fallback candidates in chain exhausted or unreachable.' } }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Route not found' } }));
  });

  gatewayServer.on('error', () => {
    gatewayState.running = false;
  });

  gatewayServer.listen(GATEWAY_PORT, '127.0.0.1', () => {
    gatewayState.running = true;
    recordGatewayEvent('gateway-online', `Smart Streaming Gateway listening on http://127.0.0.1:${GATEWAY_PORT}/v1`);
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    show: true,
    backgroundColor: '#181818',
    title: 'OpenDocFlow — AI Agent Gateway, Smart Router & Skill Hub',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  setTimeout(startLocalSmartGateway, 50);
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
  if (gatewayServer) {
    try {
      gatewayServer.close();
    } catch (_) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

const executablePathCache = new Map();

function findExecutableOnPath(names) {
  const cacheKey = names.join('|');
  if (executablePathCache.has(cacheKey)) {
    return executablePathCache.get(cacheKey);
  }
  const fastDirs = [
    'C:\\Program Files\\nodejs',
    'C:\\Program Files\\Git\\cmd',
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps')
  ];
  const pathEnv = process.env.PATH || process.env.Path || '';
  const dirs = [...fastDirs, ...pathEnv.split(path.delimiter).filter(Boolean).slice(0, 20)];
  for (const d of dirs) {
    for (const n of names) {
      const full = path.join(d, n);
      try {
        if (fs.existsSync(full)) {
          executablePathCache.set(cacheKey, full);
          return full;
        }
      } catch (_) {}
    }
  }
  executablePathCache.set(cacheKey, null);
  return null;
}

// IPC: Instant System Status (0ms Pure-JS Check)
ipcMain.handle('studio:get-status', async (event) => {
  if (!validateSender(event)) return null;
  const cfgDir = getOpenCodeConfigDir();
  const agentsSkillsDir = path.join(os.homedir(), '.agents', 'skills');
  const opencodeSkillsDir = path.join(cfgDir, 'skills');

  const opencodeBin = findExecutableOnPath(['opencode.exe', 'opencode.cmd', 'opencode']);
  const nodeBin = findExecutableOnPath(['node.exe']);
  const gitBin = findExecutableOnPath(['git.exe']);
  const uvBin = findExecutableOnPath(['uv.exe']);
  const pyBin = findExecutableOnPath(['python.exe', 'py.exe']);
  const graphifyBin = findExecutableOnPath(['graphify.exe', 'graphify.cmd']);
  const adbBin = findExecutableOnPath(['adb.exe']);
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
      version: nodeBin ? `Node Installed` : 'Not installed',
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
    gatewayEndpoint: gatewayState.endpoint,
    gatewayRunning: gatewayState.running,
    prereqs,
    plugins,
    skills,
    mcpServers
  };
});

// IPC: Fast Zero-Process Startup Update Check
ipcMain.handle('studio:check-updates', async (event) => {
  if (!validateSender(event)) return null;
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
        const res = await fetchJsonWithHeaders(`https://registry.npmjs.org/${encodeURIComponent(pkg.id)}/latest`, {}, 4500);
        return {
          id: pkg.id,
          label: pkg.label,
          latest: (res.data && res.data.version) || 'unknown'
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
    const hasUpdate = item.latest !== 'unknown' && current !== 'installed' && current !== item.latest;
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
    let errOut = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      sendTerminal(s, 'stdout');
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      out += s;
      errOut += s;
      sendTerminal(s, 'stderr');
    });
    child.on('close', (code) => {
      if (activeTerminalProc === child) activeTerminalProc = null;
      sendTerminal(`\n[Process exited with code ${code}]\n`, 'meta');
      if (code !== 0 && gatewayState.autoBugReport) {
        captureBugReport(
          `Command failed (exit ${code}): ${command}`,
          `Command: ${command} ${args.join(' ')}\nStderr:\n${errOut || out}`,
          'command-runner'
        );
      }
      resolve({ ok: code === 0, code, output: out });
    });
  });
}

ipcMain.handle('studio:install-prereqs', async (event, ids = []) => {
  if (!validateSender(event)) return { ok: false };
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

ipcMain.handle('studio:update-all', async (event) => {
  if (!validateSender(event)) return { ok: false };
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

ipcMain.handle('studio:run-kit-restore', async (event) => {
  if (!validateSender(event)) return { ok: false };
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

ipcMain.handle('studio:update-kit', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const script = path.join(getSetupKitPath(), 'scripts', 'snapshot.ps1');
  return await runStreamedProcess('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`]);
});

ipcMain.handle('studio:new-project', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
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

ipcMain.handle('studio:search-skills', async (event, query) => {
  if (!validateSender(event)) return { ok: false };
  const skillsCmd = path.join(getOpenCodeConfigDir(), 'node_modules', '.bin', 'skills.cmd');
  if (fs.existsSync(skillsCmd)) {
    return await runStreamedProcess(`"${skillsCmd}"`, ['find', `"${query}"`]);
  }
  return await runStreamedProcess('npx', ['-y', 'skills@1.7.4', 'find', `"${query}"`]);
});

ipcMain.handle('studio:install-skill', async (event, spec) => {
  if (!validateSender(event)) return { ok: false };
  const skillsCmd = path.join(getOpenCodeConfigDir(), 'node_modules', '.bin', 'skills.cmd');
  const parts = spec.trim().split(/\s+/);
  if (fs.existsSync(skillsCmd)) {
    return await runStreamedProcess(`"${skillsCmd}"`, ['add', ...parts, '-g', '-a', 'opencode', '-y', '--copy']);
  }
  return await runStreamedProcess('npx', ['-y', 'skills@1.7.4', 'add', ...parts, '-g', '-a', 'opencode', '-y', '--copy']);
});

function fetchTextUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': 'OpenDocFlow-Universal-Importer/3.0.0' },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchTextUrl(res.headers.location, timeoutMs));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
  });
}

function normalizeToOpenCodeSkillMarkdown(rawContent, skillId, description) {
  const trimmed = String(rawContent || '').trim();
  const cleanTitle = skillId.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  const cleanDesc = (
    description || `Universal imported skill (${cleanTitle}) for OpenCode, Claude Code, Codex & AI Agents`
  ).replace(/"/g, "'");
  if (trimmed.startsWith('---') && /name\s*:/.test(trimmed.slice(0, 400))) {
    return trimmed + '\n';
  }
  return ['---', `name: ${cleanTitle}`, `description: "${cleanDesc}"`, '---', '', `# ${cleanTitle}`, '', trimmed, ''].join(
    '\n'
  );
}

function writeUniversalSkillEverywhere(skillId, skillMarkdown, syncAllAgents = true) {
  const cleanId = skillId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const targets = [path.join(getOpenCodeConfigDir(), 'skills', cleanId), path.join(os.homedir(), '.agents', 'skills', cleanId)];
  if (syncAllAgents) {
    targets.push(
      path.join(os.homedir(), '.claude', 'skills', cleanId),
      path.join(os.homedir(), '.codex', 'skills', cleanId),
      path.join(os.homedir(), '.gemini', 'config', 'skills', cleanId)
    );
  }
  const written = [];
  for (const dir of targets) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'SKILL.md');
      fs.writeFileSync(file, skillMarkdown, 'utf8');
      written.push(file);
    } catch (_) {}
  }
  return { cleanId, written };
}

ipcMain.handle('studio:import-universal-skill', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const source = String(payload.source || '').trim();
  const customName = String(payload.skillName || '').trim();
  const customDesc = String(payload.description || '').trim();
  const syncAll = payload.syncAllAgents !== false;

  if (!source && !payload.rawContent) {
    return { ok: false, error: 'Provide a URL, GitHub repo, file path, or skill instructions.' };
  }

  if (payload.rawContent && String(payload.rawContent).trim()) {
    const id = customName || `custom-skill-${Date.now()}`;
    const md = normalizeToOpenCodeSkillMarkdown(payload.rawContent, id, customDesc);
    const res = writeUniversalSkillEverywhere(id, md, syncAll);
    sendTerminal(`\n[Installed Universal Skill "${res.cleanId}" across ${res.written.length} agent directories]\n`);
    return { ok: true, skillId: res.cleanId, locations: res.written };
  }

  if (fs.existsSync(source) && fs.statSync(source).isFile()) {
    const raw = fs.readFileSync(source, 'utf8');
    const id = customName || path.basename(source, path.extname(source)) || 'imported-skill';
    const md = normalizeToOpenCodeSkillMarkdown(raw, id, customDesc);
    const res = writeUniversalSkillEverywhere(id, md, syncAll);
    sendTerminal(`\n[Imported local file "${source}" as Universal Skill "${res.cleanId}"]\n`);
    return { ok: true, skillId: res.cleanId, locations: res.written };
  }

  if (/^https?:\/\//i.test(source) && !/^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(source)) {
    let fetchUrl = source;
    const ghBlob = source.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
    if (ghBlob) {
      fetchUrl = `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}/${ghBlob[4]}`;
    }
    try {
      const text = await fetchTextUrl(fetchUrl);
      const urlLeaf = path.basename(new URL(fetchUrl).pathname).replace(/\.(md|mdc|txt|json)$/i, '');
      const id = customName || (urlLeaf && urlLeaf !== 'SKILL' ? urlLeaf : `web-skill-${Date.now()}`);
      const md = normalizeToOpenCodeSkillMarkdown(text, id, customDesc || `Imported from ${source}`);
      const res = writeUniversalSkillEverywhere(id, md, syncAll);
      sendTerminal(`\n[Downloaded & converted web skill from ${fetchUrl} -> "${res.cleanId}"]\n`);
      return { ok: true, skillId: res.cleanId, locations: res.written };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const skillsCmd = path.join(getOpenCodeConfigDir(), 'node_modules', '.bin', 'skills.cmd');
  const parts = source.split(/\s+/);
  const cliArgs = ['add', ...parts, '-g', '-a', 'opencode', '-y', '--copy'];
  const cliRes = fs.existsSync(skillsCmd)
    ? await runStreamedProcess(`"${skillsCmd}"`, cliArgs)
    : await runStreamedProcess('npx', ['-y', 'skills@1.7.4', ...cliArgs]);

  if (cliRes.ok) {
    return { ok: true, skillId: customName || parts[0], method: 'skills-cli' };
  }

  const repoMatch = source.match(/(?:github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (repoMatch) {
    const owner = repoMatch[1];
    const repo = repoMatch[2].replace(/\.git$/i, '');
    const candidateFiles = ['SKILL.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', 'README.md'];
    for (const file of candidateFiles) {
      try {
        const raw = await fetchTextUrl(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${file}`, 8000);
        if (raw && raw.trim().length > 20) {
          const id = customName || repo;
          const md = normalizeToOpenCodeSkillMarkdown(raw, id, customDesc || `Auto-converted from ${owner}/${repo} (${file})`);
          const res = writeUniversalSkillEverywhere(id, md, syncAll);
          sendTerminal(`\n[Auto-converted ${owner}/${repo}/${file} into Universal Skill "${res.cleanId}"]\n`);
          return { ok: true, skillId: res.cleanId, locations: res.written, method: 'auto-converted' };
        }
      } catch (_) {}
    }
  }

  return { ok: false, error: 'Could not import skill from the specified source.' };
});

ipcMain.handle('studio:sync-all-agent-skills', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const searchRoots = [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.claude', 'commands'),
    path.join(os.homedir(), '.codex', 'skills'),
    path.join(os.homedir(), '.gemini', 'config', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(getOpenCodeConfigDir(), 'skills')
  ];

  const synced = [];
  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(root, entry.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          const raw = fs.readFileSync(skillFile, 'utf8');
          const md = normalizeToOpenCodeSkillMarkdown(raw, entry.name);
          writeUniversalSkillEverywhere(entry.name, md, true);
          synced.push(entry.name);
        }
      } else if (entry.isFile() && /\.(md|mdc)$/i.test(entry.name)) {
        const id = path.basename(entry.name, path.extname(entry.name));
        const raw = fs.readFileSync(path.join(root, entry.name), 'utf8');
        const md = normalizeToOpenCodeSkillMarkdown(raw, id);
        writeUniversalSkillEverywhere(id, md, true);
        synced.push(id);
      }
    }
  }

  const unique = Array.from(new Set(synced));
  sendTerminal(
    `\n[Universal Cross-Agent Sync complete: ${unique.length} skills unified across OpenCode, Claude Code, Codex & Gemini]\n`
  );
  return { ok: true, count: unique.length, skills: unique };
});

ipcMain.handle('studio:install-universal-plugin', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const spec = String(payload.spec || '').trim();
  const wrapV2 = payload.wrapV2 !== false;
  if (!spec) return { ok: false, error: 'Enter an npm plugin package, GitHub URL, or local file path.' };

  const res = await runStreamedProcess('opencode', ['plugin', 'add', spec]);
  if (res.ok) {
    return { ok: true, spec, method: 'native' };
  }

  if (wrapV2) {
    const cleanName = spec.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
    const pluginsDir = path.join(getOpenCodeConfigDir(), 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const bridgePath = path.join(pluginsDir, `bridge-${cleanName}.js`);

    const bridgeCode = [
      `// Auto-generated OpenCode V2 Universal Compatibility Bridge for: ${spec}`,
      `export default {`,
      `  id: "universal-bridge-${cleanName}",`,
      `  async setup(ctx) {`,
      `    try {`,
      `      const mod = await import(${JSON.stringify(spec)});`,
      `      const target = mod.default || mod;`,
      `      if (target && typeof target.setup === "function") {`,
      `        return await target.setup(ctx);`,
      `      }`,
      `    } catch (_) {}`,
      `  }`,
      `};`,
      ``
    ].join('\n');

    fs.writeFileSync(bridgePath, bridgeCode, 'utf8');
    sendTerminal(`\n[Created OpenCode V2 Universal Compatibility Bridge at ${bridgePath}]\n`);
    return { ok: true, spec, bridgePath, method: 'v2-bridge' };
  }

  return { ok: false, error: 'Plugin installation failed.' };
});

// IPC: Providers & Multi-Key Pool Manager + Live Key Model Auto-Discovery
ipcMain.handle('studio:get-providers', async (event) => {
  if (!validateSender(event)) return null;
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
    const pool = readProviderKeyPool(p.id);
    const hasKey = pool.length > 0;
    const cfgP = cfgProviders[p.id] || {};
    const extraModels = cfgP.models ? Object.keys(cfgP.models) : [];
    const allModels = Array.from(new Set([...(p.defaultModels || []), ...extraModels]));
    return {
      ...p,
      hasKey,
      keyCount: pool.length,
      baseURL: (cfgP.settings && cfgP.settings.baseURL) || p.baseURL || '',
      models: allModels
    };
  });

  for (const [id, pCfg] of Object.entries(cfgProviders)) {
    if (!merged.some((m) => m.id === id)) {
      const pool = readProviderKeyPool(id);
      merged.push({
        id,
        name: pCfg.name || id,
        tier: 'Custom Provider',
        badge: 'CUSTOM GATEWAY',
        envKey: (customMeta[id] && customMeta[id].envKey) || `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
        keyUrl: '',
        baseURL: (pCfg.settings && pCfg.settings.baseURL) || '',
        builtin: false,
        hasKey: pool.length > 0,
        keyCount: pool.length,
        models: pCfg.models ? Object.keys(pCfg.models) : []
      });
    }
  }

  return {
    currentModel: cfg.model || '',
    providers: merged
  };
});

async function queryModelsFromProviderEndpoint(providerId, apiKey, customBaseUrl) {
  const cat = PROVIDER_CATALOG.find((c) => c.id === providerId);
  const base = (customBaseUrl || (cat && cat.baseURL) || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const firstKey = String(apiKey || '')
    .split(/\r?\n|,/)[0]
    .trim();

  // Special handling for Google Gemini native model list if needed, or OpenAI-compatible /models
  if (providerId === 'google' && firstKey) {
    try {
      const res = await fetchJsonWithHeaders(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(firstKey)}`
      );
      if (res.data && Array.isArray(res.data.models)) {
        return res.data.models
          .map((m) => String(m.name || '').replace(/^models\//, ''))
          .filter((id) => id.includes('gemini'));
      }
    } catch (_) {}
  }

  const headers = {};
  if (firstKey) {
    if (providerId === 'anthropic') {
      headers['x-api-key'] = firstKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${firstKey}`;
    }
  }

  const res = await fetchJsonWithHeaders(`${base}/models`, headers, 9000);
  const rawList = (res.data && (res.data.data || res.data.models)) || (Array.isArray(res.data) ? res.data : []);
  return rawList
    .map((m) => (typeof m === 'string' ? m : m.id || m.name))
    .filter(Boolean)
    .slice(0, 80);
}

// IPC: Live API Key Model Auto-Discovery ("Read the Models in My API Key")
ipcMain.handle('studio:discover-key-models', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const cleanId = String(payload.id || 'openrouter')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');
  let keyToUse = String(payload.apiKey || '').trim();
  const baseURL = String(payload.baseURL || '').trim();

  const keysDir = getKeysDir();
  const keyFile = path.join(keysDir, `${cleanId}.key`);
  if (keyToUse) {
    fs.writeFileSync(keyFile, keyToUse, 'utf8');
    syncEnvFile();
  } else {
    const existingPool = readProviderKeyPool(cleanId);
    keyToUse = existingPool[0] || '';
  }

  try {
    const discovered = await queryModelsFromProviderEndpoint(cleanId, keyToUse, baseURL);
    if (discovered.length > 0) {
      // Save provider & discovered models into opencode.jsonc automatically
      const catalogEntry = PROVIDER_CATALOG.find((c) => c.id === cleanId);
      const isBuiltin = Boolean(catalogEntry && catalogEntry.builtin);
      let cfg = {};
      try {
        cfg = jsonc.parse(readConfigText()) || {};
      } catch (_) {}
      const existingProvider = (cfg.providers && cfg.providers[cleanId]) || {};
      const providerObj = { ...existingProvider };
      if (!isBuiltin) {
        providerObj.name = (catalogEntry && catalogEntry.name) || cleanId;
        providerObj.package = (catalogEntry && catalogEntry.package) || '@opencode/ai/providers/openai-compatible';
      }
      providerObj.settings = { ...(providerObj.settings || {}) };
      if (fs.existsSync(keyFile)) {
        providerObj.settings.apiKey = `{file:${keyFile.replace(/\\/g, '/')}}`;
      }
      if (baseURL) {
        providerObj.settings.baseURL = baseURL;
      } else if (catalogEntry && catalogEntry.baseURL && !isBuiltin) {
        providerObj.settings.baseURL = catalogEntry.baseURL;
      }

      providerObj.models = { ...(providerObj.models || {}) };
      for (const mId of discovered.slice(0, 35)) {
        providerObj.models[mId] = { modelID: mId, name: mId };
      }
      writeConfigModify(['providers', cleanId], providerObj);
    }

    return {
      ok: true,
      providerId: cleanId,
      count: discovered.length,
      models: discovered
    };
  } catch (err) {
    return {
      ok: false,
      providerId: cleanId,
      error: err.message || 'Could not query /models endpoint with this key.'
    };
  }
});

ipcMain.handle('studio:save-provider', async (event, payload) => {
  if (!validateSender(event)) return { ok: false };
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

ipcMain.handle('studio:remove-provider', async (event, id) => {
  if (!validateSender(event)) return { ok: false };
  const keyFile = path.join(getKeysDir(), `${id}.key`);
  if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
  writeConfigModify(['providers', id], undefined);
  syncEnvFile();
  return { ok: true };
});

ipcMain.handle('studio:set-default-model', async (event, modelRef) => {
  if (!validateSender(event)) return { ok: false };
  writeConfigModify(['model'], modelRef.trim());
  return { ok: true, model: modelRef.trim() };
});

ipcMain.handle('studio:add-custom-model', async (event, payload) => {
  if (!validateSender(event)) return { ok: false };
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

ipcMain.handle('studio:fetch-free-models', async (event) => {
  if (!validateSender(event)) return null;
  let liveFree = [];
  try {
    const res = await fetchJsonWithHeaders('https://openrouter.ai/api/v1/models');
    const data = res.data;
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
        if (idName.includes('coder') || idName.includes('codestral') || idName.includes('devstral')) score += 500;
        if (idName.includes('qwen3') || idName.includes('qwen-3') || idName.includes('kimi-k2') || idName.includes('glm-4.5'))
          score += 380;
        if (idName.includes('deepseek')) score += 350;
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
        .slice(0, 40);
    }
  } catch (_) {}

  return {
    curated: CURATED_FREE_CODING_MODELS,
    liveOpenRouter: liveFree
  };
});

ipcMain.handle('studio:get-fallback-chain', async (event) => {
  if (!validateSender(event)) return null;
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

ipcMain.handle('studio:save-fallback-chain', async (event, payload) => {
  if (!validateSender(event)) return { ok: false };
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

ipcMain.handle('studio:switch-next-free-model', async (event) => {
  if (!validateSender(event)) return { ok: false };
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
  recordGatewayEvent('manual-switch', `Switched ${statusObj.fromModel} -> ${nextModel}`);
  return { ok: true, ...statusObj };
});

// IPC: Local Smart Gateway Telemetry, Cache & Multi-IDE Auto-Configurator
ipcMain.handle('studio:get-gateway-telemetry', async (event) => {
  if (!validateSender(event)) return null;
  return gatewayState;
});

ipcMain.handle('studio:update-gateway-settings', async (event, settings = {}) => {
  if (!validateSender(event)) return { ok: false };
  if (settings.strategy) gatewayState.strategy = settings.strategy;
  if (typeof settings.compressionEnabled === 'boolean') gatewayState.compressionEnabled = settings.compressionEnabled;
  if (typeof settings.promptCacheEnabled === 'boolean') gatewayState.promptCacheEnabled = settings.promptCacheEnabled;
  if (typeof settings.autoBugReport === 'boolean') gatewayState.autoBugReport = settings.autoBugReport;
  recordGatewayEvent('settings-updated', `Strategy=${gatewayState.strategy}, Compression=${gatewayState.compressionEnabled}`);
  return { ok: true, ...gatewayState };
});

ipcMain.handle('studio:clear-prompt-cache', async (event) => {
  if (!validateSender(event)) return { ok: false };
  promptMemoryCache.clear();
  recordGatewayEvent('cache-cleared', 'Prompt cache cleared');
  return { ok: true };
});

ipcMain.handle('studio:connect-local-gateway', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const gatewayProvider = {
    name: 'OpenDocFlow Smart Gateway',
    package: '@opencode/ai/providers/openai-compatible',
    settings: {
      baseURL: `http://127.0.0.1:${GATEWAY_PORT}/v1`
    },
    models: {
      'auto-coding': {
        modelID: 'auto-coding',
        name: 'Auto Coding Combo (3-Layer Self-Healing + Streaming)'
      },
      auto: {
        modelID: 'auto',
        name: 'Auto Balanced Combo'
      }
    }
  };
  writeConfigModify(['providers', 'studio-gateway'], gatewayProvider);
  writeConfigModify(['model'], 'studio-gateway/auto-coding');
  recordGatewayEvent('opencode-connected', 'Connected OpenCode V2 to http://127.0.0.1:4141/v1 (studio-gateway/auto-coding)');
  return { ok: true, model: 'studio-gateway/auto-coding', endpoint: gatewayState.endpoint };
});

// 1-Click Connect All IDEs (OpenCode V2, Claude Code, Codex, Cursor/Cline/Aider env script)
ipcMain.handle('studio:connect-all-ides', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const gatewayProvider = {
    name: 'OpenDocFlow Smart Gateway',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${GATEWAY_PORT}/v1` },
    models: {
      'auto-coding': { modelID: 'auto-coding', name: 'Auto Coding Combo (3-Layer Self-Healing)' }
    }
  };
  writeConfigModify(['providers', 'studio-gateway'], gatewayProvider);
  writeConfigModify(['model'], 'studio-gateway/auto-coding');

  const cfgDir = getOpenCodeConfigDir();
  const idePs1 = path.join(cfgDir, 'ide-gateway-env.ps1');
  const ps1Content = [
    '# OpenDocFlow v3.0 - Universal IDE Gateway Environment',
    '$env:OPENAI_BASE_URL = "http://127.0.0.1:4141/v1"',
    '$env:OPENAI_API_BASE = "http://127.0.0.1:4141/v1"',
    '$env:OPENAI_API_KEY = "studio-local-gateway"',
    '$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:4141"',
    '$env:ANTHROPIC_API_KEY = "studio-local-gateway"',
    'Write-Host "Connected shell to OpenDocFlow Smart Gateway (http://127.0.0.1:4141/v1)" -ForegroundColor Green'
  ].join('\n');
  fs.writeFileSync(idePs1, ps1Content, 'utf8');

  sendTerminal(
    `\n[Connected OpenCode V2 + generated Claude Code / Codex / Cursor / Aider gateway script at ${idePs1}]\n`
  );
  recordGatewayEvent('all-ides-connected', 'Configured OpenCode V2 + Claude/Codex/Cursor/Aider gateway profile');
  return { ok: true, scriptPath: idePs1 };
});

// Interactive Routing Pipeline Layout Persistence
ipcMain.handle('studio:get-node-graph', async (event) => {
  if (!validateSender(event)) return null;
  const f = path.join(getStudioDataDir(), 'routing-graph-layout.json');
  if (fs.existsSync(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) {}
  }
  return null;
});

ipcMain.handle('studio:save-node-graph', async (event, graph) => {
  if (!validateSender(event)) return { ok: false };
  const f = path.join(getStudioDataDir(), 'routing-graph-layout.json');
  fs.writeFileSync(f, JSON.stringify(graph, null, 2), 'utf8');
  return { ok: true };
});

// ============================================================================
// CLOUD SIGN-IN (GITHUB / GOOGLE) & AES-256-GCM CROSS-PC SYNC
// ============================================================================
function getCloudAccountFile() {
  return path.join(getStudioDataDir(), 'cloud-account.json');
}

function loadCloudAccount() {
  const f = getCloudAccountFile();
  if (!fs.existsSync(f)) return { signedIn: false };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return { signedIn: false };
  }
}

function saveCloudAccount(obj) {
  fs.writeFileSync(getCloudAccountFile(), JSON.stringify(obj, null, 2), 'utf8');
}

function encryptWithPassphrase(plainText, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(String(passphrase), salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'AES-256-GCM',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64')
  };
}

function decryptWithPassphrase(encObj, passphrase) {
  const salt = Buffer.from(encObj.salt, 'base64');
  const iv = Buffer.from(encObj.iv, 'base64');
  const tag = Buffer.from(encObj.tag, 'base64');
  const data = Buffer.from(encObj.data, 'base64');
  const key = crypto.pbkdf2Sync(String(passphrase), salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

ipcMain.handle('studio:get-cloud-account', async (event) => {
  if (!validateSender(event)) return { signedIn: false };
  return loadCloudAccount();
});

ipcMain.handle('studio:cloud-signout', async (event) => {
  if (!validateSender(event)) return { ok: false };
  saveCloudAccount({ signedIn: false });
  const ghCloudKey = path.join(getKeysDir(), 'cloud-github.key');
  if (fs.existsSync(ghCloudKey)) fs.unlinkSync(ghCloudKey);
  return { ok: true };
});

ipcMain.handle('studio:cloud-signin', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const provider = payload.provider || 'github';

  if (provider === 'github') {
    let token = String(payload.token || '').trim();
    if (!token) {
      const ghPool = readProviderKeyPool('github-models');
      if (ghPool.length > 0) token = ghPool[0];
    }
    if (!token) {
      await shell.openExternal('https://github.com/settings/tokens/new?scopes=gist,repo&description=OpenCode+Studio+Cloud+Sync');
      return {
        ok: false,
        needsToken: true,
        message: 'Opened GitHub Token page in browser. Generate a token with "gist" scope and paste it to complete sign-in.'
      };
    }

    try {
      const userRes = await fetchJsonWithHeaders('https://api.github.com/user', {
        Authorization: `Bearer ${token}`
      });
      if (userRes.status === 200 && userRes.data && userRes.data.login) {
        fs.writeFileSync(path.join(getKeysDir(), 'cloud-github.key'), token, 'utf8');
        const current = loadCloudAccount();
        const acct = {
          signedIn: true,
          provider: 'github',
          username: userRes.data.login,
          displayName: userRes.data.name || userRes.data.login,
          avatarUrl: userRes.data.avatar_url || '',
          gistId: current.gistId || '',
          lastSyncedAt: current.lastSyncedAt || null
        };
        saveCloudAccount(acct);
        return { ok: true, account: acct };
      }
      return { ok: false, error: 'GitHub token rejected or invalid.' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Google Account / Google Drive Cloud Folder Sign-In
  if (provider === 'google') {
    const email = String(payload.email || 'Google Drive Sync User').trim();
    const defaultDrive =
      [
        path.join(os.homedir(), 'Google Drive'),
        path.join(os.homedir(), 'My Drive'),
        path.join(os.homedir(), 'OneDrive')
      ].find((d) => fs.existsSync(d)) || getStudioDataDir();
    const syncFolder = String(payload.syncFolder || defaultDrive).trim();
    const acct = {
      signedIn: true,
      provider: 'google',
      username: email,
      displayName: email,
      syncFolder,
      lastSyncedAt: null
    };
    saveCloudAccount(acct);
    return { ok: true, account: acct };
  }

  return { ok: false, error: 'Unsupported cloud provider' };
});

function buildCloudSyncBundle(passphrase = '') {
  const cfgDir = getOpenCodeConfigDir();
  const chainFile = path.join(cfgDir, 'free-fallback-chain.json');
  const graphFile = path.join(getStudioDataDir(), 'routing-graph-layout.json');
  const skillsDir = path.join(os.homedir(), '.agents', 'skills');

  const bundle = {
    version: '3.0.0',
    exportedAt: new Date().toISOString(),
    strategy: gatewayState.strategy,
    compressionEnabled: gatewayState.compressionEnabled,
    fallbackChain: fs.existsSync(chainFile) ? JSON.parse(fs.readFileSync(chainFile, 'utf8')) : null,
    nodeGraph: fs.existsSync(graphFile) ? JSON.parse(fs.readFileSync(graphFile, 'utf8')) : null,
    installedSkills: fs.existsSync(skillsDir)
      ? fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : []
  };

  if (passphrase && String(passphrase).trim()) {
    const allKeys = {};
    const kDir = getKeysDir();
    if (fs.existsSync(kDir)) {
      for (const f of fs.readdirSync(kDir)) {
        if (f.endsWith('.key') && f !== 'cloud-github.key') {
          const id = f.replace(/\.key$/, '');
          allKeys[id] = fs.readFileSync(path.join(kDir, f), 'utf8');
        }
      }
    }
    bundle.encryptedKeys = encryptWithPassphrase(JSON.stringify(allKeys), passphrase);
  }

  return bundle;
}

function applyCloudSyncBundle(bundle, passphrase = '') {
  if (!bundle || typeof bundle !== 'object') return;
  const cfgDir = getOpenCodeConfigDir();
  fs.mkdirSync(cfgDir, { recursive: true });

  if (bundle.strategy) gatewayState.strategy = bundle.strategy;
  if (typeof bundle.compressionEnabled === 'boolean') gatewayState.compressionEnabled = bundle.compressionEnabled;

  if (bundle.fallbackChain) {
    fs.writeFileSync(path.join(cfgDir, 'free-fallback-chain.json'), JSON.stringify(bundle.fallbackChain, null, 2), 'utf8');
  }
  if (bundle.nodeGraph) {
    fs.writeFileSync(path.join(getStudioDataDir(), 'routing-graph-layout.json'), JSON.stringify(bundle.nodeGraph, null, 2), 'utf8');
  }
  if (bundle.encryptedKeys && passphrase && String(passphrase).trim()) {
    const rawJson = decryptWithPassphrase(bundle.encryptedKeys, passphrase);
    const keysMap = JSON.parse(rawJson);
    const kDir = getKeysDir();
    for (const [id, val] of Object.entries(keysMap)) {
      fs.writeFileSync(path.join(kDir, `${id}.key`), String(val), 'utf8');
    }
    syncEnvFile();
  }
}

function upsertGitHubGist(token, gistId, contentStr) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      description: 'OpenDocFlow v3.0 Encrypted Cloud Workspace Sync',
      public: false,
      files: {
        'OpenDocFlow-sync.json': {
          content: contentStr
        }
      }
    });
    const method = gistId ? 'PATCH' : 'POST';
    const urlPath = gistId ? `/gists/${gistId}` : '/gists';

    const req = https.request(
      `https://api.github.com${urlPath}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'OpenDocFlow-Cloud-Sync/3.0.0',
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 15000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300 && parsed.id) {
              resolve({ ok: true, gistId: parsed.id, url: parsed.html_url });
            } else {
              resolve({ ok: false, error: parsed.message || `HTTP ${res.statusCode}` });
            }
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(payload);
    req.end();
  });
}

ipcMain.handle('studio:cloud-push', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const acct = loadCloudAccount();
  if (!acct.signedIn) return { ok: false, error: 'Sign in with GitHub or Google first.' };

  const bundle = buildCloudSyncBundle(payload.passphrase || '');
  const jsonStr = JSON.stringify(bundle, null, 2);

  if (acct.provider === 'github') {
    const tokenFile = path.join(getKeysDir(), 'cloud-github.key');
    const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    if (!token) return { ok: false, error: 'GitHub token missing. Please sign in again.' };

    const res = await upsertGitHubGist(token, acct.gistId || '', jsonStr);
    if (!res.ok && acct.gistId) {
      // Retry creating a fresh secret gist if previous gistId was deleted
      const retry = await upsertGitHubGist(token, '', jsonStr);
      if (retry.ok) {
        acct.gistId = retry.gistId;
        acct.lastSyncedAt = new Date().toISOString();
        saveCloudAccount(acct);
        return { ok: true, gistId: retry.gistId, url: retry.url, account: acct };
      }
      return retry;
    }
    if (res.ok) {
      acct.gistId = res.gistId;
      acct.lastSyncedAt = new Date().toISOString();
      saveCloudAccount(acct);
      return { ok: true, gistId: res.gistId, url: res.url, account: acct };
    }
    return res;
  }

  if (acct.provider === 'google') {
    const folder = acct.syncFolder || getStudioDataDir();
    fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, 'OpenDocFlow-sync.json');
    fs.writeFileSync(filePath, jsonStr, 'utf8');
    acct.lastSyncedAt = new Date().toISOString();
    saveCloudAccount(acct);
    return { ok: true, filePath, account: acct };
  }

  return { ok: false, error: 'Unknown provider' };
});

ipcMain.handle('studio:cloud-pull', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const acct = loadCloudAccount();
  if (!acct.signedIn) return { ok: false, error: 'Sign in with GitHub or Google first.' };

  try {
    if (acct.provider === 'github') {
      const tokenFile = path.join(getKeysDir(), 'cloud-github.key');
      const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
      const gistId = String(payload.gistId || acct.gistId || '').trim();
      if (!gistId) return { ok: false, error: 'No Cloud Gist ID found. Push from your first PC or enter Gist ID.' };

      const res = await fetchJsonWithHeaders(`https://api.github.com/gists/${gistId}`, {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      });
      const fileObj = res.data && res.data.files && res.data.files['OpenDocFlow-sync.json'];
      if (!fileObj || !fileObj.content) {
        return { ok: false, error: 'Could not find OpenDocFlow-sync.json in that Gist.' };
      }
      const bundle = JSON.parse(fileObj.content);
      applyCloudSyncBundle(bundle, payload.passphrase || '');
      acct.gistId = gistId;
      acct.lastSyncedAt = new Date().toISOString();
      saveCloudAccount(acct);
      return { ok: true, account: acct };
    }

    if (acct.provider === 'google') {
      const folder = acct.syncFolder || getStudioDataDir();
      const filePath = path.join(folder, 'OpenDocFlow-sync.json');
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `No sync file found at ${filePath}` };
      }
      const bundle = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      applyCloudSyncBundle(bundle, payload.passphrase || '');
      acct.lastSyncedAt = new Date().toISOString();
      saveCloudAccount(acct);
      return { ok: true, account: acct };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: false };
});

// ============================================================================
// MICROCK/OpenDocFlow FEATURE PARITY & UPGRADES:
// 1. Bulk Multi-URL Skill Importer
// 2. Live Skill & Plugin Code Editor + Raw Config / System Prompt Editor
// 3. Visual MCP Server Manager (Toggle ON/OFF, Add via npx/cmd/url, Delete)
// 4. Custom Agents (with Permissions & Mode) & Slash Commands Studio
// 5. Isolated Profiles Manager (~/.config/opencode-profiles/)
// 6. opendocflow:// Deep Link Protocol Handler
// ============================================================================
try {
  app.setAsDefaultProtocolClient('opendocflow');
} catch (_) {}

ipcMain.handle('studio:bulk-import-skills', async (event, urlsText = '') => {
  if (!validateSender(event)) return { ok: false };
  const lines = String(urlsText)
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter(Boolean);
  const imported = [];
  for (const url of lines) {
    try {
      let fetchUrl = url;
      const ghBlob = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
      if (ghBlob) {
        fetchUrl = `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}/${ghBlob[4]}`;
      }
      const raw = await fetchTextUrl(fetchUrl, 12000);
      const parts = new URL(fetchUrl).pathname.split('/').filter(Boolean);
      const leaf = parts[parts.length - 1].replace(/\.(md|mdc|txt)$/i, '');
      const parentDir = parts.length >= 2 ? parts[parts.length - 2] : '';
      const id = leaf && leaf.toUpperCase() !== 'SKILL' ? leaf : parentDir || `skill-${Date.now()}`;
      const md = normalizeToOpenCodeSkillMarkdown(raw, id, `Bulk imported from ${url}`);
      const res = writeUniversalSkillEverywhere(id, md, true);
      imported.push(res.cleanId);
    } catch (e) {
      sendTerminal(`\n[Bulk import skipped ${url}: ${e.message}]\n`, 'stderr');
    }
  }
  sendTerminal(`\n[Bulk Imported ${imported.length} skills across all agents: ${imported.join(', ')}]\n`);
  return { ok: true, count: imported.length, imported };
});

ipcMain.handle('studio:read-item-file', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const { kind, name } = payload;
  const cfgDir = getOpenCodeConfigDir();
  if (kind === 'skill') {
    const p1 = path.join(cfgDir, 'skills', name, 'SKILL.md');
    const p2 = path.join(os.homedir(), '.agents', 'skills', name, 'SKILL.md');
    const target = fs.existsSync(p1) ? p1 : p2;
    if (fs.existsSync(target)) {
      return { ok: true, path: target, content: fs.readFileSync(target, 'utf8') };
    }
  } else if (kind === 'plugin') {
    const p = path.join(cfgDir, 'plugins', name.endsWith('.js') ? name : `${name}.js`);
    if (fs.existsSync(p)) {
      return { ok: true, path: p, content: fs.readFileSync(p, 'utf8') };
    }
  }
  return { ok: false, error: 'File not found on disk.' };
});

ipcMain.handle('studio:save-item-file', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const { kind, name, content } = payload;
  const cfgDir = getOpenCodeConfigDir();
  if (kind === 'skill') {
    const res = writeUniversalSkillEverywhere(name, content, true);
    return { ok: true, locations: res.written };
  }
  if (kind === 'plugin') {
    const pDir = path.join(cfgDir, 'plugins');
    fs.mkdirSync(pDir, { recursive: true });
    const file = path.join(pDir, name.endsWith('.js') ? name : `${name}.js`);
    fs.writeFileSync(file, String(content || ''), 'utf8');
    return { ok: true, path: file };
  }
  return { ok: false };
});

// MCP Manager
ipcMain.handle('studio:get-mcps', async (event) => {
  if (!validateSender(event)) return [];
  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const mcpBlock = cfg.mcp || {};
  const serversMap = mcpBlock.servers && typeof mcpBlock.servers === 'object' ? mcpBlock.servers : mcpBlock;
  const list = [];
  for (const [name, val] of Object.entries(serversMap)) {
    if (name === 'timeout' || !val || typeof val !== 'object') continue;
    const isEnabled = val.disabled === true ? false : val.enabled !== false;
    list.push({
      name,
      type: val.type || (val.url ? 'remote' : 'local'),
      command: Array.isArray(val.command) ? val.command.join(' ') : val.url || '',
      enabled: isEnabled
    });
  }
  return list;
});

ipcMain.handle('studio:toggle-mcp', async (event, { name, enabled }) => {
  if (!validateSender(event)) return { ok: false };
  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const usesNested = Boolean(cfg.mcp && cfg.mcp.servers);
  const pathArr = usesNested ? ['mcp', 'servers', name] : ['mcp', name];
  const current = (usesNested ? cfg.mcp.servers[name] : cfg.mcp && cfg.mcp[name]) || {};
  current.enabled = Boolean(enabled);
  current.disabled = !enabled;
  writeConfigModify(pathArr, current);
  return { ok: true };
});

ipcMain.handle('studio:add-mcp', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const cleanName = String(payload.name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');
  const cmdOrUrl = String(payload.commandOrUrl || '').trim();
  if (!cleanName || !cmdOrUrl) return { ok: false, error: 'Name and command/URL are required.' };

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const usesNested = Boolean(cfg.mcp && cfg.mcp.servers);
  const pathArr = usesNested ? ['mcp', 'servers', cleanName] : ['mcp', cleanName];

  let entry = {};
  if (/^https?:\/\//i.test(cmdOrUrl)) {
    entry = { type: 'remote', url: cmdOrUrl, enabled: true };
  } else {
    const parts = cmdOrUrl.match(/(?:[^\s"]+|"[^"]*")+/g) || [cmdOrUrl];
    entry = {
      type: 'local',
      command: parts.map((p) => p.replace(/^"|"$/g, '')),
      enabled: true
    };
  }
  writeConfigModify(pathArr, entry);
  return { ok: true, name: cleanName };
});

ipcMain.handle('studio:remove-mcp', async (event, name) => {
  if (!validateSender(event)) return { ok: false };
  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const usesNested = Boolean(cfg.mcp && cfg.mcp.servers);
  const pathArr = usesNested ? ['mcp', 'servers', name] : ['mcp', name];
  writeConfigModify(pathArr, undefined);
  return { ok: true };
});

// Custom Agents & Slash Commands Manager
ipcMain.handle('studio:get-agents-commands', async (event) => {
  if (!validateSender(event)) return { agents: [], commands: [] };
  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const agents = Object.entries(cfg.agents || {}).map(([id, a]) => ({
    id,
    description: a.description || '',
    mode: a.mode || 'subagent',
    model: a.model || '',
    system: a.system || '',
    permissions: a.permissions || []
  }));
  const commands = Object.entries(cfg.commands || {}).map(([id, c]) => ({
    id,
    description: c.description || '',
    template: c.template || ''
  }));
  return { agents, commands };
});

ipcMain.handle('studio:save-agent', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const id = String(payload.id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');
  if (!id) return { ok: false };
  const agentObj = {
    description: payload.description || `Custom agent ${id}`,
    mode: payload.mode || 'subagent',
    ...(payload.model ? { model: payload.model.trim() } : {}),
    ...(payload.system ? { system: payload.system } : {})
  };
  if (payload.readOnly) {
    agentObj.permissions = [
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'write', resource: '*', effect: 'deny' }
    ];
  }
  writeConfigModify(['agents', id], agentObj);
  return { ok: true, id };
});

ipcMain.handle('studio:delete-agent', async (event, id) => {
  if (!validateSender(event)) return { ok: false };
  writeConfigModify(['agents', id], undefined);
  return { ok: true };
});

ipcMain.handle('studio:save-command', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const id = String(payload.id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');
  if (!id || !payload.template) return { ok: false };
  writeConfigModify(['commands', id], {
    description: payload.description || `Slash command /${id}`,
    template: payload.template
  });
  return { ok: true, id };
});

ipcMain.handle('studio:delete-command', async (event, id) => {
  if (!validateSender(event)) return { ok: false };
  writeConfigModify(['commands', id], undefined);
  return { ok: true };
});

// Raw Configs & System Prompt (opencode.jsonc, cli.json, AGENTS.md)
ipcMain.handle('studio:get-raw-configs', async (event) => {
  if (!validateSender(event)) return null;
  const cfgDir = getOpenCodeConfigDir();
  const cliPath = path.join(cfgDir, 'cli.json');
  const agentsMdPath = path.join(cfgDir, 'AGENTS.md');
  return {
    opencodeJsonc: readConfigText(),
    cliJson: fs.existsSync(cliPath)
      ? fs.readFileSync(cliPath, 'utf8')
      : '{\n  "$schema": "https://opencode.ai/v2/cli.json",\n  "theme": { "name": "palenight", "mode": "dark" }\n}\n',
    agentsMd: fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, 'utf8') : '# Global Agent Instructions\n'
  };
});

ipcMain.handle('studio:save-raw-configs', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const cfgDir = getOpenCodeConfigDir();
  fs.mkdirSync(cfgDir, { recursive: true });
  if (typeof payload.opencodeJsonc === 'string') {
    fs.writeFileSync(path.join(cfgDir, 'opencode.jsonc'), payload.opencodeJsonc, 'utf8');
  }
  if (typeof payload.cliJson === 'string') {
    fs.writeFileSync(path.join(cfgDir, 'cli.json'), payload.cliJson, 'utf8');
  }
  if (typeof payload.agentsMd === 'string') {
    fs.writeFileSync(path.join(cfgDir, 'AGENTS.md'), payload.agentsMd, 'utf8');
  }
  return { ok: true };
});

// Isolated Environment Profiles Manager (~/.config/opencode-profiles/)
function getProfilesRoot() {
  const dir = path.join(os.homedir(), '.config', 'opencode-profiles');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('studio:get-profiles', async (event) => {
  if (!validateSender(event)) return [];
  const root = getProfilesRoot();
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
});

ipcMain.handle('studio:save-profile', async (event, name) => {
  if (!validateSender(event)) return { ok: false };
  const clean = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');
  if (!clean) return { ok: false };
  const pDir = path.join(getProfilesRoot(), clean);
  fs.mkdirSync(pDir, { recursive: true });
  const cfgDir = getOpenCodeConfigDir();
  for (const f of ['opencode.jsonc', 'cli.json', 'AGENTS.md', 'free-fallback-chain.json']) {
    const src = path.join(cfgDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pDir, f));
  }
  return { ok: true, name: clean };
});

ipcMain.handle('studio:switch-profile', async (event, name) => {
  if (!validateSender(event)) return { ok: false };
  const pDir = path.join(getProfilesRoot(), name);
  if (!fs.existsSync(pDir)) return { ok: false, error: 'Profile folder not found.' };
  const cfgDir = getOpenCodeConfigDir();
  fs.mkdirSync(cfgDir, { recursive: true });
  for (const f of ['opencode.jsonc', 'cli.json', 'AGENTS.md', 'free-fallback-chain.json']) {
    const src = path.join(pDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(cfgDir, f));
  }
  return { ok: true, name };
});
ipcMain.handle('studio:get-bug-reports', async (event) => {
  if (!validateSender(event)) return [];
  return loadBugReports();
});

ipcMain.handle('studio:clear-bug-reports', async (event) => {
  if (!validateSender(event)) return { ok: false };
  fs.writeFileSync(getBugLogPath(), '[]', 'utf8');
  return { ok: true };
});

function postGitHubIssueWithToken(token, title, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      title,
      body,
      labels: ['bug', 'auto-reported']
    });
    const req = https.request(
      `https://api.github.com/repos/${GITHUB_REPO}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'OpenDocFlow-Bug-Reporter/3.0.0',
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 12000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300 && parsed.html_url) {
              resolve({ ok: true, url: parsed.html_url, number: parsed.number, method: 'api' });
            } else {
              resolve({ ok: false, error: parsed.message || `HTTP ${res.statusCode}` });
            }
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(payload);
    req.end();
  });
}

ipcMain.handle('studio:report-bug-github', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const cleanTitle = redactSecrets(payload.title || 'Bug Report from OpenDocFlow v3.0').slice(0, 140);
  const cleanDesc = redactSecrets(payload.description || '');
  const cleanSteps = redactSecrets(payload.steps || '');

  const issueBody = [
    '### Bug Report (Submitted via OpenDocFlow v3.0)',
    '',
    `**Summary:** ${cleanTitle}`,
    `**OS / Arch:** ${os.platform()} ${os.release()} (${os.arch()})`,
    `**App Version:** v${app.getVersion()} (Node ${process.versions.node})`,
    `**Gateway Strategy:** ${gatewayState.strategy}`,
    '',
    '### Description & Error Logs',
    '```text',
    cleanDesc || 'No stack trace provided.',
    '```',
    cleanSteps ? `\n### Steps to Reproduce / Developer Notes\n${cleanSteps}` : ''
  ].join('\n');

  const ghPool = readProviderKeyPool('github-models');
  if (ghPool.length > 0) {
    const apiRes = await postGitHubIssueWithToken(ghPool[0], cleanTitle, issueBody);
    if (apiRes.ok) return apiRes;
  }

  const issueUrl =
    `https://github.com/${GITHUB_REPO}/issues/new?title=` +
    encodeURIComponent(cleanTitle) +
    `&labels=` +
    encodeURIComponent('bug,user-report') +
    `&body=` +
    encodeURIComponent(issueBody);
  await shell.openExternal(issueUrl);
  return { ok: true, url: issueUrl, method: 'browser' };
});

ipcMain.handle('studio:terminal-run', async (event, { cmd, cwd }) => {
  if (!validateSender(event)) return { ok: false };
  if (!cmd || !cmd.trim()) return { ok: true };
  return await runStreamedProcess(cmd, [], cwd || os.homedir());
});

ipcMain.handle('studio:terminal-stop', async (event) => {
  if (!validateSender(event)) return { ok: false };
  if (activeTerminalProc) {
    try {
      activeTerminalProc.kill();
      activeTerminalProc = null;
      sendTerminal('\n[Process terminated by user]\n', 'stderr');
    } catch (_) {}
  }
  return { ok: true };
});

ipcMain.handle('studio:open-external-terminal', async (event, { cwd, cmd }) => {
  if (!validateSender(event)) return { ok: false };
  const dir = cwd || os.homedir();
  const commandText = cmd || 'opencode';
  spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', `Set-Location '${dir}'; ${commandText}`], {
    detached: true,
    windowsHide: false
  });
  return { ok: true };
});

ipcMain.handle('studio:open-path', async (event, targetPath) => {
  if (!validateSender(event)) return { ok: false };
  await shell.openPath(targetPath);
  return { ok: true };
});

ipcMain.handle('studio:open-url', async (event, url) => {
  if (!validateSender(event)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('studio:pick-directory', async (event) => {
  if (!validateSender(event)) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('studio:create-desktop-shortcut', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const desktop = app.getPath('desktop');
  const shortcutPath = path.join(desktop, 'OpenDocFlow.lnk');
  const target = process.execPath;
  const ok = shell.writeShortcutLink(shortcutPath, 'create', {
    target,
    cwd: path.dirname(target),
    description: 'OpenDocFlow - AI Agent Gateway, Smart Router & Skill Hub',
    icon: target,
    iconIndex: 0
  });
  return { ok, shortcutPath };
});
