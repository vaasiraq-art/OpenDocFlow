const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');
const jsonc = require('jsonc-parser');

const GITHUB_REPO = 'vaasiraq-art/opencode-studio';
const GATEWAY_PORT = 4141;

let mainWindow = null;
let activeTerminalProc = null;
let gatewayServer = null;

// Live Gateway Telemetry & 3-Layer Resilience State
const gatewayState = {
  running: false,
  port: GATEWAY_PORT,
  endpoint: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
  strategy: 'smart-coding',
  compressionEnabled: true,
  autoBugReport: true,
  requestsTotal: 0,
  failoversSaved: 0,
  tokensSaved: 0,
  lastGoodModel: null,
  roundRobinIndex: 0,
  circuitBreakers: {}, // providerId -> { failures, openUntil }
  keyCooldowns: {}, // providerId -> cooldownUntil
  modelLockouts: {}, // modelRef -> lockoutUntil
  recentEvents: []
};

function recordGatewayEvent(type, detail) {
  gatewayState.recentEvents.unshift({
    ts: new Date().toISOString(),
    type,
    detail
  });
  if (gatewayState.recentEvents.length > 40) {
    gatewayState.recentEvents.length = 40;
  }
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

function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'OpenCode-Studio/2.0.0',
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
    badge: 'FREE 1M CONTEXT',
    envKey: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    builtin: true,
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (All Free & Paid Models)',
    tier: 'Free & Paid',
    badge: '35+ FREE CODING MODELS',
    envKey: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    baseURL: 'https://openrouter.ai/api/v1',
    builtin: true,
    defaultModels: [
      'qwen/qwen3-coder:free',
      'deepseek/deepseek-r1:free',
      'deepseek/deepseek-chat-v3-0324:free',
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
    defaultModels: ['llama-3.3-70b-versatile', 'qwen-qwq-32b', 'deepseek-r1-distill-llama-70b']
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
    id: 'nvidia',
    name: 'NVIDIA NIM (Build Free Credits)',
    tier: 'Free & Paid',
    badge: 'FREE DEV CREDITS',
    envKey: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com/',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    package: '@opencode/ai/providers/openai-compatible',
    builtin: false,
    defaultModels: ['qwen/qwen2.5-coder-32b-instruct', 'deepseek-ai/deepseek-r1']
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
    baseURL: 'https://api.openai.com/v1',
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
    baseURL: 'https://api.x.ai/v1',
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
    strengths: '1M context window, full repository reasoning, multi-file architecture & debugging.',
    howToUse: 'Add a free Google AI Studio key and click Use Model.'
  },
  {
    rank: 2,
    tierLabel: 'S+ Tier (Best Open-Weights Coder)',
    id: 'openrouter/qwen/qwen3-coder:free',
    provider: 'openrouter',
    name: 'Qwen 3 Coder 480B A35B (Free via OpenRouter / Cerebras)',
    context: '262,144',
    strengths: 'Purpose-built agentic coding model, top tool-use & repo refactoring.',
    howToUse: 'Add a free OpenRouter or Cerebras key and click Use Model.'
  },
  {
    rank: 3,
    tierLabel: 'S Tier (Deep Reasoning & Math/Systems)',
    id: 'openrouter/deepseek/deepseek-r1:free',
    provider: 'openrouter',
    name: 'DeepSeek R1 (Free via OpenRouter / GitHub / NVIDIA)',
    context: '163,840',
    strengths: 'Root-cause bug hunting, complex algorithms, C++/Rust/systems engineering.',
    howToUse: 'Add a free OpenRouter key and click Use Model.'
  },
  {
    rank: 4,
    tierLabel: 'S Tier (Fast Daily Coding Driver)',
    id: 'openrouter/deepseek/deepseek-chat-v3-0324:free',
    provider: 'openrouter',
    name: 'DeepSeek V3 0324 (Free via OpenRouter)',
    context: '163,840',
    strengths: 'Clean, fast full-stack code generation across TS, Python, C#, GDScript.',
    howToUse: 'Add a free OpenRouter key and click Use Model.'
  },
  {
    rank: 5,
    tierLabel: 'A+ Tier (High-Speed 1M Agentic)',
    id: 'google/gemini-2.5-flash',
    provider: 'google',
    name: 'Gemini 2.5 Flash (Google AI Studio Free Tier)',
    context: '1,000,000',
    strengths: 'Generous free rate limits, ultra-fast tool execution, long sessions.',
    howToUse: 'Add a free Google AI Studio key and click Use Model.'
  },
  {
    rank: 6,
    tierLabel: 'A+ Tier (2000 tok/s Wafer-Scale)',
    id: 'cerebras/qwen-3-coder-480b',
    provider: 'cerebras',
    name: 'Qwen 3 Coder 480B (Cerebras Free Tier)',
    context: '128,000',
    strengths: 'Instant full-file generation at 2,000+ tokens/sec on Cerebras hardware.',
    howToUse: 'Add a free Cerebras key and click Use Model.'
  },
  {
    rank: 7,
    tierLabel: 'A+ Tier (80+ Languages Specialist)',
    id: 'mistral/codestral-latest',
    provider: 'mistral',
    name: 'Mistral Codestral (Mistral Free Tier)',
    context: '256,000',
    strengths: '256K context, fast code edits, diffs, and unit test generation.',
    howToUse: 'Add a free Mistral AI key and click Use Model.'
  },
  {
    rank: 8,
    tierLabel: 'A Tier (Instant LPU Inference)',
    id: 'groq/llama-3.3-70b-versatile',
    provider: 'groq',
    name: 'Llama 3.3 70B Versatile (Groq Free Tier)',
    context: '128,000',
    strengths: '300+ tokens/sec on Groq LPU, zero-wait responses for web & scripts.',
    howToUse: 'Add a free Groq key and click Use Model.'
  },
  {
    rank: 9,
    tierLabel: 'A Tier (Compact Reasoning LPU)',
    id: 'groq/qwen-qwq-32b',
    provider: 'groq',
    name: 'Qwen QwQ 32B Reasoning (Groq Free Tier)',
    context: '128,000',
    strengths: 'Step-by-step reasoning at LPU speed.',
    howToUse: 'Add a free Groq key and click Use Model.'
  },
  {
    rank: 10,
    tierLabel: 'B+ Tier (100% Offline Local GPU/CPU)',
    id: 'ollama/qwen2.5-coder:14b',
    provider: 'ollama',
    name: 'Qwen 2.5 Coder 14B / 7B (Local Ollama)',
    context: '128,000',
    strengths: 'Zero API limits, 100% private offline fallback when internet/quotas finish.',
    howToUse: 'Run: ollama pull qwen2.5-coder:14b'
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

// ============================================================================
// BUILT-IN ZERO-BLOAT LOCAL SMART AI GATEWAY (http://127.0.0.1:4141/v1)
// Compresses redundant tool output tokens & auto-fails over across 3 layers
// ============================================================================
function compressMessagesPayload(bodyObj) {
  if (!gatewayState.compressionEnabled || !bodyObj || !Array.isArray(bodyObj.messages)) {
    return { bodyObj, savedChars: 0 };
  }
  let savedChars = 0;
  const compressed = bodyObj.messages.map((msg) => {
    if (typeof msg.content === 'string' && msg.content.length > 1200 && (msg.role === 'tool' || msg.role === 'user')) {
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

  const keysDir = getKeysDir();
  const now = Date.now();
  const candidates = [];

  for (const fullRef of chain) {
    const slash = fullRef.indexOf('/');
    if (slash === -1) continue;
    const providerId = fullRef.slice(0, slash);
    const modelId = fullRef.slice(slash + 1);

    // Check Layer 3: Model lockout
    if ((gatewayState.modelLockouts[fullRef] || 0) > now) continue;
    // Check Layer 2: Key cooldown
    if ((gatewayState.keyCooldowns[providerId] || 0) > now) continue;
    // Check Layer 1: Provider circuit breaker
    const cb = gatewayState.circuitBreakers[providerId];
    if (cb && cb.openUntil > now) continue;

    const cat = PROVIDER_CATALOG.find((p) => p.id === providerId);
    const keyFile = path.join(keysDir, `${providerId}.key`);
    const apiKey = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';

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
      model: candidate.modelId
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

function startLocalSmartGateway() {
  if (gatewayServer) return;
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
        { id: 'auto-coding', object: 'model', owned_by: 'opencode-studio' },
        { id: 'auto', object: 'model', owned_by: 'opencode-studio' },
        { id: 'auto-fast', object: 'model', owned_by: 'opencode-studio' },
        ...CURATED_FREE_CODING_MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: m.provider }))
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        gatewayState.requestsTotal++;
        let bodyObj = {};
        try {
          bodyObj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
          return;
        }

        const { bodyObj: compressedBody, savedChars } = compressMessagesPayload(bodyObj);
        if (savedChars > 0) {
          gatewayState.tokensSaved += Math.ceil(savedChars / 4);
        }

        const candidates = getConfiguredFallbackCandidates();
        if (candidates.length === 0) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: 'No eligible provider keys or local Ollama active. Add a free API key in OpenCode Studio -> AI Keys.'
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
            if (i > 0) {
              gatewayState.failoversSaved++;
              recordGatewayEvent('failover-success', `Rerouted seamlessly to ${cand.fullRef}`);
            } else {
              recordGatewayEvent('served', `Served by ${cand.fullRef}`);
            }
            res.writeHead(upstream.status, {
              'Content-Type': upstream.headers['content-type'] || 'application/json',
              'X-Studio-Routed-Model': cand.fullRef,
              'X-Studio-Strategy': gatewayState.strategy
            });
            res.end(upstream.body);
            return;
          }

          // Handle 3-Layer Resilience on error
          const now = Date.now();
          if (upstream.status === 429 || upstream.status === 402) {
            gatewayState.modelLockouts[cand.fullRef] = now + 10 * 60 * 1000;
            gatewayState.keyCooldowns[cand.providerId] = now + 15 * 1000;
            recordGatewayEvent('quota-lockout', `${cand.fullRef} hit HTTP ${upstream.status} -> switching next free model`);
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
    recordGatewayEvent('gateway-online', `Smart AI Gateway listening on http://127.0.0.1:${GATEWAY_PORT}/v1`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#181818',
    title: 'OpenCode Studio v2.0 — Blender Workspace Edition',
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
  startLocalSmartGateway();
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
  if (gatewayServer) {
    try {
      gatewayServer.close();
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

// IPC: Install selected prerequisites / drivers
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
        headers: { 'User-Agent': 'OpenCode-Studio-Universal-Importer/2.0.0' },
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
  const cleanDesc = (description || `Universal imported skill (${cleanTitle}) for OpenCode, Claude Code, Codex & AI Agents`).replace(/"/g, "'");
  if (trimmed.startsWith('---') && /name\s*:/.test(trimmed.slice(0, 400))) {
    return trimmed + '\n';
  }
  return [
    '---',
    `name: ${cleanTitle}`,
    `description: "${cleanDesc}"`,
    '---',
    '',
    `# ${cleanTitle}`,
    '',
    trimmed,
    ''
  ].join('\n');
}

function writeUniversalSkillEverywhere(skillId, skillMarkdown, syncAllAgents = true) {
  const cleanId = skillId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const targets = [
    path.join(getOpenCodeConfigDir(), 'skills', cleanId),
    path.join(os.homedir(), '.agents', 'skills', cleanId)
  ];
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

// IPC: Universal Skill Importer (Any Web URL, GitHub Repo, Claude Code, Codex, Cursor, Windsurf, or Raw Text)
ipcMain.handle('studio:import-universal-skill', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const source = String(payload.source || '').trim();
  const customName = String(payload.skillName || '').trim();
  const customDesc = String(payload.description || '').trim();
  const syncAll = payload.syncAllAgents !== false;

  if (!source && !payload.rawContent) {
    return { ok: false, error: 'Provide a URL, GitHub repo, file path, or skill instructions.' };
  }

  // Case 1: Direct raw text/markdown pasted by user
  if (payload.rawContent && String(payload.rawContent).trim()) {
    const id = customName || `custom-skill-${Date.now()}`;
    const md = normalizeToOpenCodeSkillMarkdown(payload.rawContent, id, customDesc);
    const res = writeUniversalSkillEverywhere(id, md, syncAll);
    sendTerminal(`\n[Installed Universal Skill "${res.cleanId}" across ${res.written.length} agent directories]\n`);
    return { ok: true, skillId: res.cleanId, locations: res.written };
  }

  // Case 2: Local file path (.md, .mdc, .cursorrules, CLAUDE.md, AGENTS.md, SKILL.md)
  if (fs.existsSync(source) && fs.statSync(source).isFile()) {
    const raw = fs.readFileSync(source, 'utf8');
    const id = customName || path.basename(source, path.extname(source)) || 'imported-skill';
    const md = normalizeToOpenCodeSkillMarkdown(raw, id, customDesc);
    const res = writeUniversalSkillEverywhere(id, md, syncAll);
    sendTerminal(`\n[Imported local file "${source}" as Universal Skill "${res.cleanId}"]\n`);
    return { ok: true, skillId: res.cleanId, locations: res.written };
  }

  // Case 3: Direct raw HTTPS URL to a file (.md, .mdc, .cursorrules, .txt, blob, raw)
  if (/^https?:\/\//i.test(source) && !/^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(source)) {
    let fetchUrl = source;
    // Convert GitHub blob URL to raw.githubusercontent.com automatically
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

  // Case 4: GitHub repo shorthand (owner/repo) or repo URL -> try skills.sh CLI first, then auto-convert repo rules
  const skillsCmd = path.join(getOpenCodeConfigDir(), 'node_modules', '.bin', 'skills.cmd');
  const parts = source.split(/\s+/);
  const cliArgs = ['add', ...parts, '-g', '-a', 'opencode', '-y', '--copy'];
  const cliRes = fs.existsSync(skillsCmd)
    ? await runStreamedProcess(`"${skillsCmd}"`, cliArgs)
    : await runStreamedProcess('npx', ['-y', 'skills@1.7.4', ...cliArgs]);

  if (cliRes.ok) {
    return { ok: true, skillId: customName || parts[0], method: 'skills-cli' };
  }

  // Fallback for repos without standard SKILL.md (e.g. CursorRules, Claude CLAUDE.md, Codex AGENTS.md, or README.md)
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

// IPC: Sync & Harvest All Skills Across Claude Code, Codex, Gemini, Cursor & OpenCode on This PC
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
  sendTerminal(`\n[Universal Cross-Agent Sync complete: ${unique.length} skills unified across OpenCode, Claude Code, Codex & Gemini]\n`);
  return { ok: true, count: unique.length, skills: unique };
});

// IPC: Universal Plugin Installer + V1-to-V2 Compatibility Bridge
ipcMain.handle('studio:install-universal-plugin', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const spec = String(payload.spec || '').trim();
  const wrapV2 = payload.wrapV2 !== false;
  if (!spec) return { ok: false, error: 'Enter an npm plugin package, GitHub URL, or local file path.' };

  // Try native opencode plugin add first
  const res = await runStreamedProcess('opencode', ['plugin', 'add', spec]);
  if (res.ok) {
    return { ok: true, spec, method: 'native' };
  }

  // If native add failed (e.g. V1 plugin or custom script/repo), generate a safe OpenCode V2 bridge plugin
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

// IPC: Providers & API Key Manager
ipcMain.handle('studio:get-providers', async (event) => {
  if (!validateSender(event)) return null;
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

  for (const [id, pCfg] of Object.entries(cfgProviders)) {
    if (!merged.some((m) => m.id === id)) {
      const keyFile = path.join(keysDir, `${id}.key`);
      const hasKey = fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8').trim().length > 0;
      merged.push({
        id,
        name: pCfg.name || id,
        tier: 'Custom Provider',
        badge: 'CUSTOM GATEWAY',
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

// IPC: Ranked Free Coding Models
ipcMain.handle('studio:fetch-free-models', async (event) => {
  if (!validateSender(event)) return null;
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

// IPC: Auto-Fallback Free Model Chain
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

// IPC: Local Smart Gateway Telemetry & Controls
ipcMain.handle('studio:get-gateway-telemetry', async (event) => {
  if (!validateSender(event)) return null;
  return gatewayState;
});

ipcMain.handle('studio:update-gateway-settings', async (event, settings = {}) => {
  if (!validateSender(event)) return { ok: false };
  if (settings.strategy) gatewayState.strategy = settings.strategy;
  if (typeof settings.compressionEnabled === 'boolean') gatewayState.compressionEnabled = settings.compressionEnabled;
  if (typeof settings.autoBugReport === 'boolean') gatewayState.autoBugReport = settings.autoBugReport;
  recordGatewayEvent('settings-updated', `Strategy=${gatewayState.strategy}, Compression=${gatewayState.compressionEnabled}`);
  return { ok: true, ...gatewayState };
});

ipcMain.handle('studio:connect-local-gateway', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const gatewayProvider = {
    name: 'OpenCode Studio Smart Gateway',
    package: '@opencode/ai/providers/openai-compatible',
    settings: {
      baseURL: `http://127.0.0.1:${GATEWAY_PORT}/v1`
    },
    models: {
      'auto-coding': {
        modelID: 'auto-coding',
        name: 'Auto Coding Combo (3-Layer Self-Healing)'
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

// IPC: Auto Bug Catcher & GitHub Issue Reporter
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
          'User-Agent': 'OpenCode-Studio-Bug-Reporter/2.0.0',
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
  const cleanTitle = redactSecrets(payload.title || 'Bug Report from OpenCode Studio').slice(0, 140);
  const cleanDesc = redactSecrets(payload.description || '');
  const cleanSteps = redactSecrets(payload.steps || '');

  const issueBody = [
    '### Bug Report (Submitted via OpenCode Studio v2.0)',
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

  // Try direct API submission if a GitHub token is saved in keys
  const ghKeyFile = path.join(getKeysDir(), 'github-models.key');
  if (fs.existsSync(ghKeyFile)) {
    const token = fs.readFileSync(ghKeyFile, 'utf8').trim();
    if (token) {
      const apiRes = await postGitHubIssueWithToken(token, cleanTitle, issueBody);
      if (apiRes.ok) return apiRes;
    }
  }

  // Fallback: Open pre-filled GitHub New Issue page in browser so any user/coder can submit in 1 click
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

// IPC: Embedded Terminal & OS Helpers
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
  const shortcutPath = path.join(desktop, 'OpenCode Studio.lnk');
  const target = process.execPath;
  const ok = shell.writeShortcutLink(shortcutPath, 'create', {
    target,
    cwd: path.dirname(target),
    description: 'OpenCode Studio v2.0 - Blender Workspace AI Gateway & Coding Hub',
    icon: target,
    iconIndex: 0
  });
  return { ok, shortcutPath };
});
