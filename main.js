'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const jsonc = require('jsonc-parser');

const { PROVIDER_CATALOG, CURATED_FREE_CODING_MODELS } = require('./lib/providers-catalog');
const {
  redactSecretsText,
  packRepositoryToMarkdown,
  getRecentGitCommits,
  buildDocFlowSystemPrompt
} = require('./lib/docflow-engine');
const {
  translateAnthropicRequestToOpenAI,
  translateOpenAIResponseToAnthropic,
  sendCachedAsSse,
  executeUpstreamCandidate,
  benchmarkSingleCandidate,
  runParallelBenchmark,
  hashPromptCacheKey
} = require('./lib/gateway-benchmark');
const {
  clearExecCache,
  detectDefaultPortableRoot,
  findExecutableSmart,
  buildEnhancedEnv,
  killProcessTree,
  OPENDOCFLOW_AGENT_TEAM,
  OPENDOCFLOW_SLASH_COMMANDS,
  MCP_MARKETPLACE_CATALOG,
  getAgentsHubState,
  runTurboParallelInstall
} = require('./lib/agents-installer');
const { runAgentTurn, abortActiveAgentRun } = require('./lib/agent-runner');

const GITHUB_REPO = 'vaasiraq-art/OpenDocFlow';
const GATEWAY_PORT = 4141;

// Default to Zero-Black-Screen Rendering (eliminates DawnGraphite/Intel Iris Xe shader hangs & black windows)
// Users can opt into hardware GPU by unchecking "Safe GPU Mode" in Turbo Installer or passing --enable-gpu.
function checkSafeGpuBootFlag() {
  if (process.argv.includes('--enable-gpu')) return false;
  if (process.argv.includes('--safe-gpu')) return true;
  try {
    const settingsFile = path.join(app.getPath('userData'), 'studio-data', 'studio-settings.json');
    if (fs.existsSync(settingsFile)) {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (typeof parsed.safeGpuMode === 'boolean') return parsed.safeGpuMode;
    }
  } catch (_) {}
  return true;
}

if (checkSafeGpuBootFlag()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}
// Prevent Windows token-integrity / sandbox / NetworkService startup deadlocks (<500ms cold start)
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity,NetworkServiceSandbox');
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

if (!process.argv.includes('--smoke-test')) {
  const gotSingleLock = app.requestSingleInstanceLock();
  if (!gotSingleLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }
}

let mainWindow = null;
let activeTerminalProc = null;
let gatewayServer = null;
let telemetrySaveTimer = null;

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
  lastTokPerSec: 0,
  lastGoodModel: null,
  roundRobinIndex: 0,
  keyPoolIndices: {},
  circuitBreakers: {},
  keyCooldowns: {},
  modelLockouts: {},
  providerSpeeds: {},
  recentEvents: [],
  recentRequests: []
};

const promptMemoryCache = new Map();
const keyPoolMemCache = new Map();

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

function getSettingsPath() {
  return path.join(getStudioDataDir(), 'studio-settings.json');
}

let cachedSettings = null;
function loadStudioSettings() {
  if (cachedSettings) return cachedSettings;
  const defRoot = detectDefaultPortableRoot(__dirname);
  cachedSettings = {
    portableRoot: defRoot,
    usePortablePrefix: Boolean(defRoot),
    safeGpuMode: true
  };
  try {
    const f = getSettingsPath();
    if (fs.existsSync(f)) {
      cachedSettings = { ...cachedSettings, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    }
  } catch (_) {}
  return cachedSettings;
}

function saveStudioSettingsSync(nextSettings) {
  cachedSettings = { ...loadStudioSettings(), ...nextSettings };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(cachedSettings, null, 2), 'utf8');
  clearExecCache();
  return cachedSettings;
}

// GPU crash watchdog: automatically falls back to safe mode if driver crashes
app.on('child-process-gone', (_event, details) => {
  if (details && details.type === 'GPU' && details.reason === 'crashed') {
    try {
      saveStudioSettingsSync({ safeGpuMode: true });
    } catch (_) {}
  }
});

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
      gatewayState.lastTokPerSec = Number(saved.lastTokPerSec) || 0;
      if (saved.providerSpeeds && typeof saved.providerSpeeds === 'object') {
        gatewayState.providerSpeeds = saved.providerSpeeds;
      }
      if (saved.strategy) gatewayState.strategy = saved.strategy;
    }
  } catch (_) {}
}

function scheduleSaveTelemetry() {
  if (telemetrySaveTimer) return;
  telemetrySaveTimer = setTimeout(async () => {
    telemetrySaveTimer = null;
    try {
      await fsp.writeFile(
        getTelemetryFilePath(),
        JSON.stringify(
          {
            requestsTotal: gatewayState.requestsTotal,
            cacheHits: gatewayState.cacheHits,
            failoversSaved: gatewayState.failoversSaved,
            tokensSaved: gatewayState.tokensSaved,
            avgLatencyMs: gatewayState.avgLatencyMs,
            lastTokPerSec: gatewayState.lastTokPerSec,
            providerSpeeds: gatewayState.providerSpeeds,
            strategy: gatewayState.strategy
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (_) {}
  }, 2500);
}

function recordGatewayEvent(type, detail, reqEntry = null) {
  const evt = { ts: new Date().toISOString(), type, detail };
  gatewayState.recentEvents.unshift(evt);
  if (gatewayState.recentEvents.length > 40) gatewayState.recentEvents.length = 40;

  if (reqEntry) {
    gatewayState.recentRequests.unshift({
      id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ts: evt.ts,
      ...reqEntry
    });
    if (gatewayState.recentRequests.length > 60) gatewayState.recentRequests.length = 60;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('studio:gateway-event', { event: evt, reqEntry });
  }
  scheduleSaveTelemetry();
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

function getBundledMcpScriptPath() {
  const unpacked = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'mcp', 'opendocflow-mcp.mjs');
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(__dirname, 'mcp', 'opendocflow-mcp.mjs');
}

function getOpenCodeConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

function getBugLogPath() {
  return path.join(getStudioDataDir(), 'bug-reports.json');
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
      title: redactSecretsText(title).slice(0, 140),
      detail: redactSecretsText(detail).slice(0, 4000),
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
          'User-Agent': 'OpenDocFlow/4.0.0',
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
// CACHED CONFIG & IN-MEMORY MULTI-KEY POOL MANAGER (0ms Gateway Reads)
// ============================================================================
let cachedConfigText = null;
let cachedConfigTime = 0;
let cachedFallbackObj = null;
let cachedFallbackTime = 0;

function invalidateConfigCache() {
  cachedConfigText = null;
  cachedConfigTime = 0;
  cachedFallbackObj = null;
  cachedFallbackTime = 0;
}

function readConfigText() {
  const now = Date.now();
  if (cachedConfigText !== null && now - cachedConfigTime < 8000) {
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

function invalidateKeyPoolCache(providerId) {
  if (providerId) keyPoolMemCache.delete(providerId);
  else keyPoolMemCache.clear();
}

function readProviderKeyPool(providerId) {
  if (keyPoolMemCache.has(providerId)) {
    return keyPoolMemCache.get(providerId);
  }
  const keyFile = path.join(getKeysDir(), `${providerId}.key`);
  if (!fs.existsSync(keyFile)) {
    keyPoolMemCache.set(providerId, []);
    return [];
  }
  const pool = fs
    .readFileSync(keyFile, 'utf8')
    .split(/\r?\n|,/)
    .map((k) => k.trim())
    .filter(Boolean);
  keyPoolMemCache.set(providerId, pool);
  return pool;
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
  const lines = ['# Generated by OpenDocFlow v4.0 - Keep private, never commit'];
  for (const cat of PROVIDER_CATALOG) {
    const pool = readProviderKeyPool(cat.id);
    if (pool.length > 0 && cat.envKey) {
      lines.push(`${cat.envKey}=${pool[0]}`);
      if (cat.id === 'google') lines.push(`GOOGLE_GENERATIVE_AI_API_KEY=${pool[0]}`);
    }
  }
  for (const [id, info] of Object.entries(meta)) {
    if (PROVIDER_CATALOG.some((c) => c.id === id)) continue;
    const pool = readProviderKeyPool(id);
    if (pool.length > 0 && info.envKey) {
      lines.push(`${info.envKey}=${pool[0]}`);
    }
  }
  const envPath = path.join(getOpenCodeConfigDir(), '.env');
  fs.mkdirSync(getOpenCodeConfigDir(), { recursive: true });
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

function readFallbackConfigCached() {
  const now = Date.now();
  if (cachedFallbackObj && now - cachedFallbackTime < 8000) return cachedFallbackObj;
  const chainFile = path.join(getOpenCodeConfigDir(), 'free-fallback-chain.json');
  let obj = {
    enabled: true,
    cooldownMinutes: 15,
    chain: CURATED_FREE_CODING_MODELS.map((m) => m.id)
  };
  if (fs.existsSync(chainFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
      obj = { ...obj, ...parsed };
    } catch (_) {}
  }
  cachedFallbackObj = obj;
  cachedFallbackTime = now;
  return obj;
}

// ============================================================================
// REAL-TIME STREAMING + MULTI-PROTOCOL SMART GATEWAY (:4141/v1)
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

function buildCandidateFromFullRef(fullRef, cfgProviders = {}) {
  const slash = String(fullRef || '').indexOf('/');
  if (slash === -1) return null;
  const providerId = fullRef.slice(0, slash);
  const modelId = fullRef.slice(slash + 1);
  if (providerId === 'studio-gateway') return null;

  const cat = PROVIDER_CATALOG.find((p) => p.id === providerId);
  const cfgP = cfgProviders[providerId] || {};
  const apiKey = pickKeyFromPool(providerId);
  const localNoKey = Boolean(cat && cat.localNoKey);

  if (!apiKey && !localNoKey) return null;
  const baseURL = (cfgP.settings && cfgP.settings.baseURL) || (cat && cat.baseURL) || 'https://openrouter.ai/api/v1';
  return {
    fullRef,
    providerId,
    providerName: (cat && cat.name) || providerId,
    modelId,
    apiKey,
    baseURL,
    localNoKey
  };
}

function getEligibleGatewayCandidates(requestedModel = '') {
  const fbCfg = readFallbackConfigCached();
  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const cfgProviders = cfg.providers || {};

  const isAutoAlias =
    !requestedModel ||
    ['auto', 'auto-coding', 'auto-fast', 'auto-fusion', 'opendocflow-agent', 'studio-gateway/auto-coding', 'openai/auto-coding'].includes(
      requestedModel
    );

  const now = Date.now();
  const candidates = [];
  const seen = new Set();

  // 1. Honor explicit provider/model request first
  if (!isAutoAlias && requestedModel.includes('/')) {
    const direct = buildCandidateFromFullRef(requestedModel, cfgProviders);
    if (direct) {
      candidates.push(direct);
      seen.add(direct.fullRef);
      if (fbCfg.enabled === false) return candidates;
    }
  }

  // 2. Build fallback chain candidates
  const chainList = Array.isArray(fbCfg.chain) && fbCfg.chain.length > 0 ? fbCfg.chain : CURATED_FREE_CODING_MODELS.map((m) => m.id);

  let orderedRefs = [...chainList];
  if (gatewayState.strategy === 'fastest-toks') {
    orderedRefs.sort((a, b) => {
      const pA = a.split('/')[0];
      const pB = b.split('/')[0];
      return (gatewayState.providerSpeeds[pB] || 0) - (gatewayState.providerSpeeds[pA] || 0);
    });
  } else if (gatewayState.strategy === 'lkgp' && gatewayState.lastGoodModel) {
    orderedRefs.sort((a, b) => (a === gatewayState.lastGoodModel ? -1 : b === gatewayState.lastGoodModel ? 1 : 0));
  } else if (gatewayState.strategy === 'round-robin' && orderedRefs.length > 1) {
    const shift = gatewayState.roundRobinIndex % orderedRefs.length;
    gatewayState.roundRobinIndex++;
    orderedRefs = [...orderedRefs.slice(shift), ...orderedRefs.slice(0, shift)];
  }

  for (const fullRef of orderedRefs) {
    if (seen.has(fullRef)) continue;
    const slash = fullRef.indexOf('/');
    if (slash === -1) continue;
    const providerId = fullRef.slice(0, slash);

    if ((gatewayState.modelLockouts[fullRef] || 0) > now) continue;
    if ((gatewayState.keyCooldowns[providerId] || 0) > now) continue;
    const cb = gatewayState.circuitBreakers[providerId];
    if (cb && cb.openUntil > now) continue;

    const cand = buildCandidateFromFullRef(fullRef, cfgProviders);
    if (cand) {
      candidates.push(cand);
      seen.add(fullRef);
      if (fbCfg.enabled === false && candidates.length >= 1) break;
    }
  }

  // 3. Also append any user-configured provider keys that weren't in default chain
  if (candidates.length === 0) {
    for (const cat of PROVIDER_CATALOG) {
      if (cat.localNoKey) continue;
      const pool = readProviderKeyPool(cat.id);
      if (pool.length > 0 && cat.defaultModels && cat.defaultModels[0]) {
        const ref = `${cat.id}/${cat.defaultModels[0]}`;
        const cand = buildCandidateFromFullRef(ref, cfgProviders);
        if (cand) candidates.push(cand);
      }
    }
  }

  return candidates;
}

function startLocalSmartGateway() {
  if (gatewayServer) return;
  loadPersistedTelemetry();

  gatewayServer = http.createServer((req, res) => {
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
        { id: 'opendocflow-agent', object: 'model', owned_by: 'OpenDocFlow' },
        { id: 'auto', object: 'model', owned_by: 'OpenDocFlow' },
        { id: 'auto-fast', object: 'model', owned_by: 'OpenDocFlow' },
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

        const wireName = isAnthropicWire ? 'Anthropic' : 'OpenAI';
        const clientRequestedStream = Boolean(rawObj.stream);
        const openAiBody = isAnthropicWire ? translateAnthropicRequestToOpenAI(rawObj) : rawObj;
        const requestedModel = String(openAiBody.model || 'auto-coding');

        const { bodyObj: compressedBody, savedChars } = compressMessagesPayload(openAiBody);
        const savedTokensThisReq = savedChars > 0 ? Math.ceil(savedChars / 4) : 0;
        if (savedTokensThisReq > 0) gatewayState.tokensSaved += savedTokensThisReq;

        // 0ms SHA-256 Prompt Memory Cache (for deterministic non-tool queries)
        const hasTools = Array.isArray(compressedBody.tools) && compressedBody.tools.length > 0;
        const cacheKey = !hasTools
          ? hashPromptCacheKey(requestedModel, compressedBody.messages, null)
          : null;

        if (gatewayState.promptCacheEnabled && cacheKey && promptMemoryCache.has(cacheKey)) {
          const cached = promptMemoryCache.get(cacheKey);
          gatewayState.cacheHits++;
          recordGatewayEvent('cache-hit', `0ms Cache Hit (${cached.model})`, {
            wire: wireName,
            requestedModel,
            routedModel: cached.model,
            status: 200,
            ttftMs: 0,
            totalMs: 1,
            tokPerSec: 9999,
            tokensSaved: savedTokensThisReq,
            cached: true
          });
          if (clientRequestedStream) {
            sendCachedAsSse(res, cached.body, cached.model, isAnthropicWire);
          } else if (isAnthropicWire) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Studio-Cache': 'HIT' });
            res.end(translateOpenAIResponseToAnthropic(cached.body, cached.model));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Studio-Cache': 'HIT' });
            res.end(cached.body);
          }
          return;
        }

        const candidates = getEligibleGatewayCandidates(requestedModel);
        if (candidates.length === 0) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message:
                  'No active API keys or local Ollama server detected. Open OpenDocFlow -> AI Keys & Scanner and paste a free API key (Google AI Studio, OpenRouter, Groq, or Cerebras).'
              }
            })
          );
          return;
        }

        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const upstream = await executeUpstreamCandidate(cand, compressedBody, {
            streamRequested: clientRequestedStream,
            isAnthropicWire,
            clientRes: res
          });

          if (upstream.ok) {
            gatewayState.lastGoodModel = cand.fullRef;
            delete gatewayState.circuitBreakers[cand.providerId];

            const dt = upstream.totalMs || 1;
            gatewayState.avgLatencyMs = gatewayState.avgLatencyMs
              ? Math.round(gatewayState.avgLatencyMs * 0.7 + upstream.ttftMs * 0.3)
              : upstream.ttftMs;

            const tokPerSec = Math.round(((upstream.estOutTokens || 1) / Math.max(0.05, dt / 1000)) * 10) / 10;
            gatewayState.lastTokPerSec = tokPerSec;
            gatewayState.providerSpeeds[cand.providerId] = tokPerSec;

            if (!upstream.streamed && gatewayState.promptCacheEnabled && cacheKey && upstream.body) {
              promptMemoryCache.set(cacheKey, { model: cand.fullRef, body: upstream.body });
              if (promptMemoryCache.size > 200) {
                promptMemoryCache.delete(promptMemoryCache.keys().next().value);
              }
            }

            if (i > 0) gatewayState.failoversSaved++;
            recordGatewayEvent(
              i > 0 ? 'failover-success' : 'served',
              `${i > 0 ? 'Failover -> ' : ''}${cand.fullRef} (${upstream.ttftMs}ms TTFT • ${tokPerSec} tok/s)`,
              {
                wire: wireName,
                requestedModel,
                routedModel: cand.fullRef,
                status: 200,
                ttftMs: upstream.ttftMs,
                totalMs: dt,
                tokPerSec,
                tokensSaved: savedTokensThisReq,
                failoverCount: i,
                cached: false
              }
            );

            // If non-streaming, write body now (streaming already piped live to res!)
            if (!upstream.streamed) {
              if (isAnthropicWire) {
                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'X-Studio-Routed-Model': cand.fullRef
                });
                res.end(translateOpenAIResponseToAnthropic(upstream.body, cand.fullRef));
              } else {
                res.writeHead(upstream.status, {
                  'Content-Type': (upstream.headers && upstream.headers['content-type']) || 'application/json',
                  'X-Studio-Routed-Model': cand.fullRef,
                  'X-Studio-Strategy': gatewayState.strategy
                });
                res.end(upstream.body);
              }
            }
            return;
          }

          // Self-Healing Failover: rotate key pool first, then lockout model on 429/402
          const now = Date.now();
          if (upstream.status === 429 || upstream.status === 402) {
            const poolSize = readProviderKeyPool(cand.providerId).length;
            if (poolSize <= 1) {
              const fbCfg = readFallbackConfigCached();
              const cooldownMs = (Number(fbCfg.cooldownMinutes) || 10) * 60 * 1000;
              gatewayState.modelLockouts[cand.fullRef] = now + cooldownMs;
              gatewayState.keyCooldowns[cand.providerId] = now + 12 * 1000;
            }
            recordGatewayEvent('quota-lockout', `${cand.fullRef} HTTP ${upstream.status} -> switching key/model`);
          } else if (upstream.status >= 500) {
            const prev = gatewayState.circuitBreakers[cand.providerId] || { failures: 0, openUntil: 0 };
            prev.failures++;
            if (prev.failures >= 3) prev.openUntil = now + 45 * 1000;
            gatewayState.circuitBreakers[cand.providerId] = prev;
            recordGatewayEvent('circuit-trip', `${cand.providerId} HTTP ${upstream.status} -> rerouting`);
          }
        }

        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'All configured provider keys/models in fallback chain were rate-limited or unreachable.' } }));
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
    recordGatewayEvent('gateway-online', `True SSE Streaming Gateway online at http://127.0.0.1:${GATEWAY_PORT}/v1`);
  });
}

// ============================================================================
// INSTANT WINDOW CREATION (<200ms Cold Launch)
// ============================================================================
function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'OpenDocFlow v4.0.1 — AI Agent Studio, Multi-Agent Hub, DocFlow & Smart Gateway',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  const isSmokeTest = process.argv.includes('--smoke-test');
  const captureArg = process.argv.find((a) => a.startsWith('--capture-screen='));
  const capturePath = captureArg ? captureArg.slice('--capture-screen='.length) : '';
  const rendererErrors = [];
  let loadCompleted = false;

  if (isSmokeTest) {
    mainWindow.webContents.on('console-message', (ev, legacyLevel, legacyMsg, legacyLine, legacySrc) => {
      if (ev && typeof ev === 'object' && ('level' in ev || 'message' in ev)) {
        if (ev.level === 'error' || ev.level >= 3) {
          rendererErrors.push(`${ev.sourceId || ''}:${ev.lineNumber || 0} ${ev.message || ''}`);
        }
      } else if (typeof legacyLevel === 'number' && legacyLevel >= 3) {
        rendererErrors.push(`${legacySrc || ''}:${legacyLine || 0} ${legacyMsg || ''}`);
      }
    });
    mainWindow.webContents.once('did-finish-load', () => {
      loadCompleted = true;
      if (capturePath && !mainWindow.isDestroyed()) {
        mainWindow.showInactive();
      }
      setTimeout(async () => {
        let capturedBytes = 0;
        if (capturePath && !mainWindow.isDestroyed()) {
          try {
            const img = await mainWindow.webContents.capturePage();
            const png = img.toPNG();
            fs.writeFileSync(capturePath, png);
            capturedBytes = png.length;
          } catch (_) {}
        }
        console.log(
          JSON.stringify({
            smokeTest: 'OK',
            electron: process.versions.electron,
            gatewayRunning: gatewayState.running,
            endpoint: gatewayState.endpoint,
            capturedBytes,
            rendererErrors
          })
        );
        if (gatewayServer) {
          try {
            gatewayServer.close();
          } catch (_) {}
        }
        app.exit(rendererErrors.length > 0 ? 1 : 0);
      }, 650);
    });
  }

  let shown = false;
  const reveal = () => {
    if (!shown && !isSmokeTest && mainWindow && !mainWindow.isDestroyed()) {
      shown = true;
      mainWindow.show();
    }
  };

  mainWindow.once('ready-to-show', reveal);
  mainWindow.webContents.once('did-finish-load', () => {
    loadCompleted = true;
    reveal();
  });
  setTimeout(reveal, 700);

  // Self-healing watchdog if renderer file load ever stalls
  setTimeout(() => {
    if (!loadCompleted && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.reloadIgnoringCache();
      } catch (_) {}
    }
  }, 3000);

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
  abortActiveAgentRun();
  if (activeTerminalProc) {
    killProcessTree(activeTerminalProc);
    activeTerminalProc = null;
  }
  if (gatewayServer) {
    try {
      gatewayServer.close();
    } catch (_) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

// ============================================================================
// IPC: CORE SYSTEM STATUS, SETTINGS & TURBO INSTALLER
// ============================================================================
ipcMain.handle('studio:get-settings', async (event) => {
  if (!validateSender(event)) return null;
  return loadStudioSettings();
});

ipcMain.handle('studio:save-settings', async (event, nextSettings = {}) => {
  if (!validateSender(event)) return { ok: false };
  const saved = saveStudioSettingsSync(nextSettings);
  return { ok: true, settings: saved };
});

ipcMain.handle('studio:get-status', async (event, forceRefresh = false) => {
  if (!validateSender(event)) return null;
  if (forceRefresh) clearExecCache();
  const settings = loadStudioSettings();
  const pRoot = settings.portableRoot || '';
  const cfgDir = getOpenCodeConfigDir();
  const agentsSkillsDir = path.join(os.homedir(), '.agents', 'skills');
  const opencodeSkillsDir = path.join(cfgDir, 'skills');

  const opencodeBin = findExecutableSmart(['opencode.cmd', 'opencode.exe', 'opencode'], { portableRoot: pRoot });
  const nodeBin = findExecutableSmart(['node.exe'], { portableRoot: pRoot });
  const gitBin = findExecutableSmart(['git.exe'], { portableRoot: pRoot });
  const uvBin = findExecutableSmart(['uv.exe'], { portableRoot: pRoot });
  const pyBin = findExecutableSmart(['python.exe', 'py.exe'], { portableRoot: pRoot });
  const graphifyBin = findExecutableSmart(['graphify.exe', 'graphify.cmd'], { portableRoot: pRoot });
  const adbBin = findExecutableSmart(['adb.exe'], { portableRoot: pRoot });
  const wtBin = findExecutableSmart(['wt.exe'], { portableRoot: pRoot });

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
  const reaPkgCandidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'rea-agents', 'package.json'),
    pRoot ? path.join(pRoot, 'npm', 'node_modules', 'rea-agents', 'package.json') : '',
    path.join(cfgDir, 'tools', 'rea', 'node_modules', 'rea-agents', 'package.json')
  ].filter(Boolean);

  for (const p of reaPkgCandidates) {
    if (fs.existsSync(p)) {
      try {
        reaVersion = JSON.parse(fs.readFileSync(p, 'utf8')).version;
        break;
      } catch (_) {}
    }
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
  const plugins = Array.isArray(cfg.plugins) ? cfg.plugins.map((p) => (typeof p === 'string' ? p : p.package)) : [];
  const mcpBlock = cfg.mcp || {};
  const mcpMap = mcpBlock.servers && typeof mcpBlock.servers === 'object' ? mcpBlock.servers : mcpBlock;
  const mcpServers = Object.keys(mcpMap).filter((k) => k !== 'timeout');

  const prereqs = [
    {
      id: 'opencode',
      name: 'OpenCode V2 CLI',
      category: 'Core AI Runtime',
      required: true,
      installed: Boolean(opencodeBin),
      version: opencodeBin ? `Ready (${path.basename(opencodeBin)})` : 'Not installed',
      description: 'Main coding agent runtime, background server, plugins & TUI.'
    },
    {
      id: 'node',
      name: 'Node.js Runtime (22.20+ / 24+)',
      category: 'Core Runtime',
      required: true,
      installed: Boolean(nodeBin),
      version: nodeBin ? 'Node Ready' : 'Not installed',
      description: 'Powers OpenDocFlow MCP, OpenCode plugins, skills CLI & CLI agents.'
    },
    {
      id: 'git',
      name: 'Git for Windows',
      category: 'Core Runtime',
      required: true,
      installed: Boolean(gitBin),
      version: gitBin ? 'Git Ready' : 'Not installed',
      description: 'Required for worktrees, DocFlow git changelogs, Aider & skill repos.'
    },
    {
      id: 'uv',
      name: 'Python + Astral uv',
      category: 'Fast Python Tooling',
      required: true,
      installed: Boolean(uvBin || pyBin),
      version: uvBin ? 'uv + Python Ready' : pyBin ? 'Python Ready' : 'Not installed',
      description: 'Ultra-fast installer for Graphify, Aider & uvx MCP servers.'
    },
    {
      id: 'graphify',
      name: 'Graphify CLI & Code Graph',
      category: 'Code Intelligence',
      required: false,
      installed: Boolean(graphifyVer || graphifyBin),
      version: graphifyVer || 'Optional',
      description: 'Builds persistent code/doc knowledge graphs for 80% lower token usage.'
    },
    {
      id: 'rea',
      name: 'REA (Reverse Engineer Anything)',
      category: 'MCP Suite (229 Tools)',
      required: false,
      installed: Boolean(reaVersion),
      version: reaVersion ? `rea-agents ${reaVersion}` : 'Optional',
      description: 'Static & dynamic binary, APK, Electron & web reverse engineering MCP.'
    },
    {
      id: 'adb',
      name: 'Android SDK Platform-Tools (ADB)',
      category: 'Mobile & Drivers',
      required: false,
      installed: Boolean(adbBin),
      version: adbBin ? 'ADB Ready' : 'Optional',
      description: 'ADB + Fastboot USB debugging tools for Android devices.'
    },
    {
      id: 'wt',
      name: 'Windows Terminal (GPU TUI)',
      category: 'Terminal App',
      required: false,
      installed: Boolean(wtBin),
      version: wtBin ? 'Installed' : 'Optional',
      description: 'Fast modern GPU terminal used when launching external CLI agents.'
    }
  ];

  return {
    appVersion: app.getVersion(),
    installPath: app.getAppPath(),
    setupKitPath: getSetupKitPath(),
    configDir: cfgDir,
    portableRoot: pRoot,
    currentModel: cfg.model || 'studio-gateway/auto-coding',
    gatewayEndpoint: gatewayState.endpoint,
    gatewayRunning: gatewayState.running,
    prereqs,
    plugins,
    skills,
    mcpServers
  };
});

ipcMain.handle('studio:check-updates', async (event) => {
  if (!validateSender(event)) return null;
  const packages = [
    { id: 'opencode-ai', label: 'OpenCode V2 CLI' },
    { id: '@google/gemini-cli', label: 'Google Gemini CLI' },
    { id: 'rea-agents', label: 'REA MCP Server' },
    { id: 'opencode-agent-memory', label: 'Agent Memory Plugin' },
    { id: 'cc-safety-net', label: 'CC Safety Net Plugin' }
  ];

  const status = await Promise.all(
    packages.map(async (pkg) => {
      try {
        const res = await fetchJsonWithHeaders(`https://registry.npmjs.org/${encodeURIComponent(pkg.id)}/latest`, {}, 4000);
        return { id: pkg.id, label: pkg.label, latest: (res.data && res.data.version) || 'unknown' };
      } catch (_) {
        return { id: pkg.id, label: pkg.label, latest: 'unknown' };
      }
    })
  );

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];

  const results = status.map((item) => {
    let current = 'installed';
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
    const settings = loadStudioSettings();
    const env = buildEnhancedEnv(settings.portableRoot || '');
    sendTerminal(`\n$ ${command} ${args.join(' ')}\n`, 'cmd');
    const child = spawn(command, args, {
      cwd: cwd || os.homedir(),
      shell: true,
      windowsHide: true,
      env
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
    child.on('error', (err) => {
      if (activeTerminalProc === child) activeTerminalProc = null;
      sendTerminal(`\n[Spawn error: ${err.message}]\n`, 'stderr');
      resolve({ ok: false, code: -1, output: out });
    });
    child.on('close', (code) => {
      if (activeTerminalProc === child) activeTerminalProc = null;
      clearExecCache();
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

// Turbo Parallel Installer for Runtimes, Tools & CLI Agents
ipcMain.handle('studio:install-prereqs', async (event, ids = [], opts = {}) => {
  if (!validateSender(event)) return { ok: false };
  const settings = loadStudioSettings();
  const portableRoot = opts.portableRoot !== undefined ? opts.portableRoot : settings.portableRoot;
  const usePortablePrefix = opts.usePortablePrefix !== undefined ? opts.usePortablePrefix : settings.usePortablePrefix;

  return await runTurboParallelInstall(ids, {
    portableRoot,
    usePortablePrefix,
    onLog: (txt, stream) => sendTerminal(txt, stream),
    onProgress: (prog) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('studio:install-progress', prog);
      }
    }
  });
});

ipcMain.handle('studio:update-all', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const settings = loadStudioSettings();
  await Promise.all([
    runStreamedProcess('opencode', ['plugin', 'update']),
    runTurboParallelInstall(['opencode', 'rea'], {
      portableRoot: settings.portableRoot,
      usePortablePrefix: settings.usePortablePrefix,
      onLog: (t, s) => sendTerminal(t, s)
    })
  ]);
  invalidateConfigCache();
  clearExecCache();
  return { ok: true };
});

ipcMain.handle('studio:run-kit-restore', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const script = path.join(getSetupKitPath(), 'scripts', 'install.ps1');
  const res = await runStreamedProcess('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`, '-Yes']);
  invalidateConfigCache();
  clearExecCache();
  return res;
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

// ============================================================================
// IPC: LIVE AGENT STUDIO, MULTI-AGENT HUB & @OPENDOCFLOW AGENT + MCP SUITE
// ============================================================================
ipcMain.handle('studio:get-agents-hub', async (event) => {
  if (!validateSender(event)) return [];
  const settings = loadStudioSettings();
  return {
    portableRoot: settings.portableRoot || '',
    usePortablePrefix: Boolean(settings.usePortablePrefix),
    agents: getAgentsHubState({ portableRoot: settings.portableRoot }),
    specialistTeam: Object.entries(OPENDOCFLOW_AGENT_TEAM).map(([id, def]) => ({ id, ...def })),
    slashCommands: Object.entries(OPENDOCFLOW_SLASH_COMMANDS).map(([id, def]) => ({ id, ...def }))
  };
});

function installNativeMcpScriptToConfigDir() {
  const cfgDir = getOpenCodeConfigDir();
  const toolsDir = path.join(cfgDir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  const dst = path.join(toolsDir, 'opendocflow-mcp.mjs');
  const src = getBundledMcpScriptPath();
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
  const settings = loadStudioSettings();
  const nodeBin = findExecutableSmart(['node.exe'], { portableRoot: settings.portableRoot }) || 'node';
  return { nodeBin, mcpScriptPath: dst };
}

ipcMain.handle('studio:install-opendocflow-suite', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const cfgDir = getOpenCodeConfigDir();
  fs.mkdirSync(cfgDir, { recursive: true });

  // 1. Register @opendocflow + 7 specialist subagents in opencode.jsonc
  for (const [id, def] of Object.entries(OPENDOCFLOW_AGENT_TEAM)) {
    const agentObj = {
      description: def.description,
      mode: def.mode || 'subagent',
      system: def.system
    };
    if (def.readOnly) {
      agentObj.permissions = [
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'write', resource: '*', effect: 'deny' }
      ];
    }
    writeConfigModify(['agents', id], agentObj);
  }

  // 2. Register 6 OpenDocFlow Slash Commands in opencode.jsonc
  for (const [cmdId, cmdDef] of Object.entries(OPENDOCFLOW_SLASH_COMMANDS)) {
    writeConfigModify(['commands', cmdId], {
      description: cmdDef.description,
      template: cmdDef.template
    });
  }

  // 3. Copy & register Native OpenDocFlow MCP Server in opencode.jsonc
  const { nodeBin, mcpScriptPath } = installNativeMcpScriptToConfigDir();
  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const usesNested = Boolean(cfg.mcp && cfg.mcp.servers);
  const mcpPathArr = usesNested ? ['mcp', 'servers', 'opendocflow'] : ['mcp', 'opendocflow'];
  writeConfigModify(mcpPathArr, {
    type: 'local',
    command: [nodeBin, mcpScriptPath],
    enabled: true
  });

  // 4. Also export @opendocflow specialist agents to ~/.claude/agents/ for Claude Code compatibility!
  try {
    const claudeAgentsDir = path.join(os.homedir(), '.claude', 'agents');
    fs.mkdirSync(claudeAgentsDir, { recursive: true });
    for (const [id, def] of Object.entries(OPENDOCFLOW_AGENT_TEAM)) {
      const md = `---\nname: ${id}\ndescription: "${def.description.replace(/"/g, "'")}"\n---\n\n${def.system}\n`;
      fs.writeFileSync(path.join(claudeAgentsDir, `${id}.md`), md, 'utf8');
    }
  } catch (_) {}

  invalidateConfigCache();
  sendTerminal(
    `\n[Installed @opendocflow Primary Agent + 7 Specialist Subagents + 6 Slash Commands + OpenDocFlow MCP Server (${mcpScriptPath})]\n`
  );
  recordGatewayEvent('opendocflow-suite-installed', 'Registered @opendocflow Agent Team + Native MCP Server');

  return {
    ok: true,
    agentsInstalled: Object.keys(OPENDOCFLOW_AGENT_TEAM).length,
    commandsInstalled: Object.keys(OPENDOCFLOW_SLASH_COMMANDS).length,
    mcpScriptPath
  };
});

ipcMain.handle('studio:agent-run', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const settings = loadStudioSettings();
  return await runAgentTurn(payload, {
    gatewayPort: GATEWAY_PORT,
    portableRoot: settings.portableRoot || '',
    emit: (chunk) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('studio:agent-stream', chunk);
      }
    }
  });
});

ipcMain.handle('studio:agent-stop', async (event) => {
  if (!validateSender(event)) return { ok: false };
  abortActiveAgentRun();
  return { ok: true };
});

ipcMain.handle('studio:launch-cli-agent', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const settings = loadStudioSettings();
  const dir = (payload.cwd && payload.cwd.trim()) || os.homedir();
  const cmdText = payload.cmd || 'opencode';
  const env = buildEnhancedEnv(settings.portableRoot || '', {
    OPENAI_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
    OPENAI_API_BASE: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
    OPENAI_API_KEY: 'studio-local-gateway',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
    ANTHROPIC_API_KEY: 'studio-local-gateway'
  });

  const wtBin = findExecutableSmart(['wt.exe'], { portableRoot: settings.portableRoot });
  const psScript = `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'; ${cmdText}`;

  if (wtBin) {
    spawn(wtBin, ['powershell.exe', '-NoExit', '-Command', psScript], {
      detached: true,
      windowsHide: false,
      env
    });
  } else {
    spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', psScript], {
      detached: true,
      windowsHide: false,
      env
    });
  }
  return { ok: true };
});

// ============================================================================
// IPC: DOCFLOW REPO PACKAGER & AI DOCS GENERATOR
// ============================================================================
ipcMain.handle('studio:docflow-pack', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  return await packRepositoryToMarkdown({
    dirPath: payload.dirPath,
    maxFiles: payload.maxFiles || 180,
    saveToFile: Boolean(payload.saveToFile)
  });
});

ipcMain.handle('studio:docflow-generate', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const dirPath = payload.dirPath || process.cwd();
  const docType = payload.docType || 'readme';
  const sessionId = payload.sessionId || `docflow_${Date.now()}`;

  const packed = await packRepositoryToMarkdown({
    dirPath,
    maxFiles: 90,
    maxFileBytes: 42 * 1024,
    maxTotalChars: 110000
  });
  if (!packed.ok) return packed;

  let gitCommits = '';
  if (docType === 'changelog' || docType === 'readme') {
    gitCommits = await getRecentGitCommits(dirPath, 35);
  }

  const sys = buildDocFlowSystemPrompt(docType);
  const userPrompt = [
    `Generate the requested "${docType.toUpperCase()}" document for repository "${packed.repoName}".`,
    gitCommits ? `\nRecent Git Commits:\n\`\`\`text\n${gitCommits}\n\`\`\`\n` : '',
    `\nRepository Context:\n${packed.markdown.slice(0, 95000)}`
  ].join('\n');

  const settings = loadStudioSettings();
  return await runAgentTurn(
    {
      engine: 'opendocflow',
      persona: 'docflow',
      model: payload.model || 'auto-coding',
      prompt: userPrompt,
      history: [{ role: 'system', content: sys }],
      workspaceDir: '',
      enableTools: false,
      allowWrite: false,
      sessionId
    },
    {
      gatewayPort: GATEWAY_PORT,
      portableRoot: settings.portableRoot || '',
      emit: (chunk) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('studio:agent-stream', chunk);
        }
      }
    }
  );
});

ipcMain.handle('studio:docflow-save-file', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const targetDir = path.resolve(String(payload.dirPath || os.homedir()));
  const fileName = path.basename(String(payload.fileName || 'README.md'));
  const fullPath = path.join(targetDir, fileName);
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(fullPath, String(payload.content || ''), 'utf8');
  return { ok: true, fullPath };
});

// ============================================================================
// IPC: UNIVERSAL WORLD SKILLS & PLUGINS HARVESTER
// ============================================================================
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
        headers: { 'User-Agent': 'OpenDocFlow-Universal-Importer/4.0.0' },
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
    description || `Universal imported skill (${cleanTitle}) for OpenCode, Claude Code, Codex, Gemini & OpenDocFlow`
  ).replace(/"/g, "'");
  if (trimmed.startsWith('---') && /name\s*:/.test(trimmed.slice(0, 400))) {
    return trimmed + '\n';
  }
  return ['---', `name: ${cleanTitle}`, `description: "${cleanDesc}"`, '---', '', `# ${cleanTitle}`, '', trimmed, ''].join('\n');
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
  sendTerminal(`\n[Universal Cross-Agent Sync complete: ${unique.length} skills unified across OpenCode, Claude Code, Codex & Gemini]\n`);
  return { ok: true, count: unique.length, skills: unique };
});

ipcMain.handle('studio:install-universal-plugin', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const spec = String(payload.spec || '').trim();
  const wrapV2 = payload.wrapV2 !== false;
  if (!spec) return { ok: false, error: 'Enter an npm plugin package, GitHub URL, or local file path.' };

  const res = await runStreamedProcess('opencode', ['plugin', 'add', spec]);
  invalidateConfigCache();
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

ipcMain.handle('studio:bulk-import-skills', async (event, urlsText = '') => {
  if (!validateSender(event)) return { ok: false };
  const lines = String(urlsText)
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter(Boolean);

  const imported = [];
  await Promise.all(
    lines.map(async (url) => {
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
    })
  );
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

// ============================================================================
// IPC: PROVIDERS, MULTI-KEY POOL, MODEL SCANNER & LIVE BENCHMARK (TOK/S)
// ============================================================================
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
      tokPerSec: gatewayState.providerSpeeds[p.id] || 0,
      baseURL: (cfgP.settings && cfgP.settings.baseURL) || p.baseURL || '',
      models: allModels
    };
  });

  for (const [id, pCfg] of Object.entries(cfgProviders)) {
    if (id === 'studio-gateway') continue;
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
        tokPerSec: gatewayState.providerSpeeds[id] || 0,
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
    invalidateKeyPoolCache(cleanId);
    syncEnvFile();
  } else {
    const existingPool = readProviderKeyPool(cleanId);
    keyToUse = existingPool[0] || '';
  }

  try {
    const discovered = await queryModelsFromProviderEndpoint(cleanId, keyToUse, baseURL);
    if (discovered.length > 0) {
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

    return { ok: true, providerId: cleanId, count: discovered.length, models: discovered };
  } catch (err) {
    return {
      ok: false,
      providerId: cleanId,
      error: err.message || 'Could not query /models endpoint with this key.'
    };
  }
});

ipcMain.handle('studio:test-provider-key', async (event, payload = {}) => {
  if (!validateSender(event)) return { ok: false };
  const id = String(payload.id || '').trim().toLowerCase();
  const cat = PROVIDER_CATALOG.find((c) => c.id === id);
  const inlineKey = String(payload.apiKey || '').trim().split(/\r?\n|,/)[0].trim();
  const apiKey = inlineKey || pickKeyFromPool(id);
  const baseURL = String(payload.baseURL || (cat && cat.baseURL) || '').trim();
  const modelId = (cat && cat.defaultModels && cat.defaultModels[0]) || 'gpt-4o-mini';

  if (!apiKey && !(cat && cat.localNoKey)) {
    return { ok: false, error: 'Paste or save an API key first.' };
  }

  const res = await benchmarkSingleCandidate({
    providerId: id,
    providerName: (cat && cat.name) || id,
    fullRef: `${id}/${modelId}`,
    modelId,
    apiKey,
    baseURL,
    localNoKey: Boolean(cat && cat.localNoKey)
  });
  if (res.ok && res.tokPerSec) {
    gatewayState.providerSpeeds[id] = res.tokPerSec;
    scheduleSaveTelemetry();
  }
  return res;
});

ipcMain.handle('studio:run-benchmark', async (event, opts = {}) => {
  if (!validateSender(event)) return { ok: false, results: [] };
  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const cfgProviders = cfg.providers || {};

  const benchCandidates = [];
  for (const cat of PROVIDER_CATALOG) {
    const pool = readProviderKeyPool(cat.id);
    if (pool.length === 0 && !cat.localNoKey) continue;
    const modelId = (cat.defaultModels && cat.defaultModels[0]) || '';
    if (!modelId) continue;
    const cfgP = cfgProviders[cat.id] || {};
    benchCandidates.push({
      providerId: cat.id,
      providerName: cat.name,
      fullRef: `${cat.id}/${modelId}`,
      modelId,
      apiKey: pool[0] || '',
      baseURL: (cfgP.settings && cfgP.settings.baseURL) || cat.baseURL,
      localNoKey: Boolean(cat.localNoKey)
    });
  }

  const results = await runParallelBenchmark(benchCandidates);
  for (const r of results) {
    if (r.ok && r.tokPerSec > 0) {
      gatewayState.providerSpeeds[r.providerId] = r.tokPerSec;
    }
  }
  scheduleSaveTelemetry();

  // Optionally sort fallback chain by fastest healthy models
  if (opts.autoSortChain) {
    const healthyModels = results.filter((r) => r.ok).map((r) => r.model);
    if (healthyModels.length > 0) {
      const fb = readFallbackConfigCached();
      const rest = (fb.chain || []).filter((m) => !healthyModels.includes(m));
      const newChain = [...healthyModels, ...rest];
      const chainFile = path.join(getOpenCodeConfigDir(), 'free-fallback-chain.json');
      fs.writeFileSync(
        chainFile,
        JSON.stringify({ enabled: fb.enabled !== false, cooldownMinutes: fb.cooldownMinutes || 15, chain: newChain }, null, 2),
        'utf8'
      );
      invalidateConfigCache();
    }
  }

  recordGatewayEvent(
    'benchmark-complete',
    `Benchmarked ${results.length} providers (${results.filter((r) => r.ok).length} healthy)`
  );
  return { ok: true, results };
});

ipcMain.handle('studio:save-provider', async (event, payload) => {
  if (!validateSender(event)) return { ok: false };
  const { id, name, apiKey, baseURL, envKey, models = [], builtin } = payload;
  const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const keysDir = getKeysDir();
  const keyFile = path.join(keysDir, `${cleanId}.key`);

  if (apiKey && apiKey.trim()) {
    fs.writeFileSync(keyFile, apiKey.trim(), 'utf8');
    invalidateKeyPoolCache(cleanId);
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
    providerObj.settings.apiKey = `{file:${keyFile.replace(/\\/g, '/')}}`;
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
  invalidateKeyPoolCache(id);
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
  if (baseURL && baseURL.trim()) existingP.settings.baseURL = baseURL.trim();
  if (apiKey && apiKey.trim()) {
    const keyFile = path.join(getKeysDir(), `${pId}.key`);
    fs.writeFileSync(keyFile, apiKey.trim(), 'utf8');
    invalidateKeyPoolCache(pId);
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
  if (setAsDefault) writeConfigModify(['model'], fullRef);
  return { ok: true, fullRef };
});

ipcMain.handle('studio:fetch-free-models', async (event) => {
  if (!validateSender(event)) return null;
  let liveFree = [];
  try {
    const res = await fetchJsonWithHeaders('https://openrouter.ai/api/v1/models', {}, 7500);
    const data = res.data;
    if (data && Array.isArray(data.data)) {
      const freeRaw = data.data.filter((m) => {
        const p = m.pricing || {};
        return ((p.prompt === '0' || p.prompt === 0) && (p.completion === '0' || p.completion === 0)) || String(m.id).endsWith(':free');
      });

      const scoreModel = (m) => {
        const idName = `${m.id} ${m.name || ''}`.toLowerCase();
        let score = 0;
        if (idName.includes('coder') || idName.includes('codestral') || idName.includes('devstral')) score += 500;
        if (idName.includes('qwen3') || idName.includes('qwen-3') || idName.includes('kimi-k2') || idName.includes('glm-4.5')) score += 380;
        if (idName.includes('deepseek')) score += 350;
        if (idName.includes('gemini-2.5') || idName.includes('gemini-2.0')) score += 320;
        if (idName.includes('llama-3.3') || idName.includes('llama-4')) score += 260;
        if (idName.includes('r1') || idName.includes('qwq')) score += 180;
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

  return { curated: CURATED_FREE_CODING_MODELS, liveOpenRouter: liveFree };
});

ipcMain.handle('studio:get-fallback-chain', async (event) => {
  if (!validateSender(event)) return null;
  const chainData = readFallbackConfigCached();
  const statusFile = path.join(getOpenCodeConfigDir(), 'free-fallback-status.json');
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
  invalidateConfigCache();
  return { ok: true, ...data };
});

ipcMain.handle('studio:switch-next-free-model', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const fb = readFallbackConfigCached();
  const chain = fb.chain && fb.chain.length > 0 ? fb.chain : CURATED_FREE_CODING_MODELS.map((m) => m.id);
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
    reason: 'Rotated to next free coding model'
  };
  fs.writeFileSync(path.join(getOpenCodeConfigDir(), 'free-fallback-status.json'), JSON.stringify(statusObj, null, 2), 'utf8');
  recordGatewayEvent('manual-switch', `Switched ${statusObj.fromModel} -> ${nextModel}`);
  return { ok: true, ...statusObj };
});

// ============================================================================
// IPC: GATEWAY TELEMETRY & MULTI-IDE CONNECTOR
// ============================================================================
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
    name: 'OpenDocFlow Smart Gateway v4',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${GATEWAY_PORT}/v1` },
    models: {
      'auto-coding': { modelID: 'auto-coding', name: 'Auto Coding Combo (True SSE + Self-Healing)' },
      'opendocflow-agent': { modelID: 'opendocflow-agent', name: 'OpenDocFlow Flagship Agent Combo' },
      auto: { modelID: 'auto', name: 'Auto Balanced Combo' }
    }
  };
  writeConfigModify(['providers', 'studio-gateway'], gatewayProvider);
  writeConfigModify(['model'], 'studio-gateway/auto-coding');
  recordGatewayEvent('opencode-connected', 'Connected OpenCode V2 to http://127.0.0.1:4141/v1 (studio-gateway/auto-coding)');
  return { ok: true, model: 'studio-gateway/auto-coding', endpoint: gatewayState.endpoint };
});

ipcMain.handle('studio:connect-all-ides', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const gatewayProvider = {
    name: 'OpenDocFlow Smart Gateway v4',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${GATEWAY_PORT}/v1` },
    models: {
      'auto-coding': { modelID: 'auto-coding', name: 'Auto Coding Combo (True SSE + Self-Healing)' }
    }
  };
  writeConfigModify(['providers', 'studio-gateway'], gatewayProvider);
  writeConfigModify(['model'], 'studio-gateway/auto-coding');

  const cfgDir = getOpenCodeConfigDir();
  const idePs1 = path.join(cfgDir, 'ide-gateway-env.ps1');
  const ps1Content = [
    '# OpenDocFlow v4.0 - Universal Multi-Agent Gateway Environment',
    '$env:OPENAI_BASE_URL = "http://127.0.0.1:4141/v1"',
    '$env:OPENAI_API_BASE = "http://127.0.0.1:4141/v1"',
    '$env:OPENAI_API_KEY = "studio-local-gateway"',
    '$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:4141"',
    '$env:ANTHROPIC_API_KEY = "studio-local-gateway"',
    'Write-Host "Connected shell to OpenDocFlow v4.0 Smart Gateway (http://127.0.0.1:4141/v1)" -ForegroundColor Green'
  ].join('\n');
  fs.writeFileSync(idePs1, ps1Content, 'utf8');

  sendTerminal(`\n[Connected OpenCode V2 + generated Claude Code / Codex / Gemini / Qwen / Cursor / Aider gateway script at ${idePs1}]\n`);
  recordGatewayEvent('all-ides-connected', 'Configured all IDEs & CLI agents to :4141/v1');
  return { ok: true, scriptPath: idePs1 };
});

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
  fs.writeFileSync(path.join(getStudioDataDir(), 'routing-graph-layout.json'), JSON.stringify(graph, null, 2), 'utf8');
  return { ok: true };
});

// ============================================================================
// IPC: MCP MARKETPLACE, CUSTOM AGENTS, COMMANDS & PROFILES
// ============================================================================
try {
  app.setAsDefaultProtocolClient('opendocflow');
} catch (_) {}

function parseConfiguredMcpsList() {
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
}

ipcMain.handle('studio:get-mcps', async (event) => {
  if (!validateSender(event)) return [];
  return parseConfiguredMcpsList();
});

ipcMain.handle('studio:get-mcp-marketplace', async (event) => {
  if (!validateSender(event)) return [];
  const configured = parseConfiguredMcpsList();
  return MCP_MARKETPLACE_CATALOG.map((item) => {
    const existing = configured.find((c) => c.name === item.id);
    return {
      ...item,
      installed: Boolean(existing),
      enabled: existing ? existing.enabled : false
    };
  });
});

ipcMain.handle('studio:install-marketplace-mcp', async (event, id) => {
  if (!validateSender(event)) return { ok: false };
  const item = MCP_MARKETPLACE_CATALOG.find((m) => m.id === id);
  if (!item) return { ok: false, error: 'Unknown MCP server ID' };

  let cfg = {};
  try {
    cfg = jsonc.parse(readConfigText()) || {};
  } catch (_) {}
  const usesNested = Boolean(cfg.mcp && cfg.mcp.servers);
  const pathArr = usesNested ? ['mcp', 'servers', item.id] : ['mcp', item.id];

  let commandArr = item.command;
  if (item.builtinMcp) {
    const { nodeBin, mcpScriptPath } = installNativeMcpScriptToConfigDir();
    commandArr = [nodeBin, mcpScriptPath];
  } else if (process.platform === 'win32' && commandArr[0] === 'npx') {
    commandArr = ['cmd.exe', '/d', '/c', ...commandArr];
  }

  writeConfigModify(pathArr, {
    type: 'local',
    command: commandArr,
    enabled: true
  });
  sendTerminal(`\n[Enabled MCP Server "${item.name}" (${item.id}) in opencode.jsonc]\n`);
  return { ok: true, id: item.id };
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
  const cleanName = String(payload.name || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
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
    entry = { type: 'local', command: parts.map((p) => p.replace(/^"|"$/g, '')), enabled: true };
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
  const id = String(payload.id || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
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
  const id = String(payload.id || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
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
  invalidateConfigCache();
  return { ok: true };
});

function getProfilesRoot() {
  const dir = path.join(os.homedir(), '.config', 'opencode-profiles');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('studio:get-profiles', async (event) => {
  if (!validateSender(event)) return [];
  return fs
    .readdirSync(getProfilesRoot(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
});

ipcMain.handle('studio:save-profile', async (event, name) => {
  if (!validateSender(event)) return { ok: false };
  const clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
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
  invalidateConfigCache();
  return { ok: true, name };
});

// ============================================================================
// IPC: CLOUD SYNC (AES-256-GCM) & BUG REPORTER
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
      await shell.openExternal('https://github.com/settings/tokens/new?scopes=gist,repo&description=OpenDocFlow+v4+Cloud+Sync');
      return {
        ok: false,
        needsToken: true,
        message: 'Opened GitHub Token page in browser. Generate a token with "gist" scope and paste it to complete sign-in.'
      };
    }

    try {
      const userRes = await fetchJsonWithHeaders('https://api.github.com/user', { Authorization: `Bearer ${token}` });
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

  if (provider === 'google') {
    const email = String(payload.email || 'Google Drive Sync User').trim();
    const defaultDrive =
      [path.join(os.homedir(), 'Google Drive'), path.join(os.homedir(), 'My Drive'), path.join(os.homedir(), 'OneDrive')].find((d) =>
        fs.existsSync(d)
      ) || getStudioDataDir();
    const syncFolder = String(payload.syncFolder || defaultDrive).trim();
    const acct = { signedIn: true, provider: 'google', username: email, displayName: email, syncFolder, lastSyncedAt: null };
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
    version: '4.0.0',
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
          allKeys[f.replace(/\.key$/, '')] = fs.readFileSync(path.join(kDir, f), 'utf8');
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
    invalidateKeyPoolCache();
    syncEnvFile();
  }
  invalidateConfigCache();
}

function upsertGitHubGist(token, gistId, contentStr) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      description: 'OpenDocFlow v4.0 Encrypted Cloud Workspace Sync',
      public: false,
      files: { 'OpenDocFlow-sync.json': { content: contentStr } }
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
          'User-Agent': 'OpenDocFlow-Cloud-Sync/4.0.0',
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
      applyCloudSyncBundle(JSON.parse(fileObj.content), payload.passphrase || '');
      acct.gistId = gistId;
      acct.lastSyncedAt = new Date().toISOString();
      saveCloudAccount(acct);
      return { ok: true, account: acct };
    }

    if (acct.provider === 'google') {
      const folder = acct.syncFolder || getStudioDataDir();
      const filePath = path.join(folder, 'OpenDocFlow-sync.json');
      if (!fs.existsSync(filePath)) return { ok: false, error: `No sync file found at ${filePath}` };
      applyCloudSyncBundle(JSON.parse(fs.readFileSync(filePath, 'utf8')), payload.passphrase || '');
      acct.lastSyncedAt = new Date().toISOString();
      saveCloudAccount(acct);
      return { ok: true, account: acct };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: false };
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
    const payload = JSON.stringify({ title, body, labels: ['bug', 'auto-reported'] });
    const req = https.request(
      `https://api.github.com/repos/${GITHUB_REPO}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'OpenDocFlow-Bug-Reporter/4.0.0',
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
  const cleanTitle = redactSecretsText(payload.title || 'Bug Report from OpenDocFlow v4.0').slice(0, 140);
  const cleanDesc = redactSecretsText(payload.description || '');
  const cleanSteps = redactSecretsText(payload.steps || '');

  const issueBody = [
    '### Bug Report (Submitted via OpenDocFlow v4.0)',
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

// ============================================================================
// IPC: TERMINAL & OS UTILITIES (WITH CLEAN TREE-KILL)
// ============================================================================
ipcMain.handle('studio:terminal-run', async (event, { cmd, cwd }) => {
  if (!validateSender(event)) return { ok: false };
  if (!cmd || !cmd.trim()) return { ok: true };
  return await runStreamedProcess(cmd, [], cwd || os.homedir());
});

ipcMain.handle('studio:terminal-stop', async (event) => {
  if (!validateSender(event)) return { ok: false };
  if (activeTerminalProc) {
    killProcessTree(activeTerminalProc);
    activeTerminalProc = null;
    sendTerminal('\n[Process tree terminated cleanly]\n', 'stderr');
  }
  return { ok: true };
});

ipcMain.handle('studio:open-external-terminal', async (event, { cwd, cmd }) => {
  if (!validateSender(event)) return { ok: false };
  const settings = loadStudioSettings();
  const dir = cwd || os.homedir();
  const commandText = cmd || 'opencode';
  const env = buildEnhancedEnv(settings.portableRoot || '');
  const wtBin = findExecutableSmart(['wt.exe'], { portableRoot: settings.portableRoot });
  const psScript = `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'; ${commandText}`;

  if (wtBin) {
    spawn(wtBin, ['powershell.exe', '-NoExit', '-Command', psScript], {
      detached: true,
      windowsHide: false,
      env
    });
  } else {
    spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', psScript], {
      detached: true,
      windowsHide: false,
      env
    });
  }
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

ipcMain.handle('studio:copy-clipboard', async (event, text) => {
  if (!validateSender(event)) return { ok: false };
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

ipcMain.handle('studio:create-desktop-shortcut', async (event) => {
  if (!validateSender(event)) return { ok: false };
  const desktop = app.getPath('desktop');
  const shortcutPath = path.join(desktop, 'OpenDocFlow.lnk');
  const target = process.execPath;
  const ok = shell.writeShortcutLink(shortcutPath, 'create', {
    target,
    cwd: path.dirname(target),
    description: 'OpenDocFlow v4.0 - AI Agent Studio, Multi-Agent Hub & Smart Gateway',
    icon: target,
    iconIndex: 0
  });
  return { ok, shortcutPath };
});
