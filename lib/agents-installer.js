'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const execCache = new Map();
const EXEC_CACHE_TTL_MS = 20000;

function clearExecCache() {
  execCache.clear();
}

function detectDefaultPortableRoot(appDir) {
  // Walk up from appDir (e.g. D:\apps\MY ai Agent\apps\opencode-studio -> D:\apps\MY ai Agent)
  const candidates = [];
  if (appDir) {
    let cur = appDir;
    for (let i = 0; i < 4; i++) {
      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      candidates.push(parent);
      cur = parent;
    }
  }
  candidates.push('D:\\apps\\MY ai Agent', 'D:\\OpenDocFlow-Tools', 'C:\\OpenDocFlow-Tools');

  for (const c of candidates) {
    try {
      if (
        fs.existsSync(path.join(c, 'npm')) ||
        fs.existsSync(path.join(c, 'tools')) ||
        fs.existsSync(path.join(c, 'uvtools'))
      ) {
        return c;
      }
    } catch (_) {}
  }
  return '';
}

function getExtraSearchDirs(portableRoot = '') {
  const dirs = [];
  const roots = [portableRoot].filter(Boolean);

  for (const r of roots) {
    dirs.push(
      path.join(r, 'npm'),
      path.join(r, 'tools', 'nodejs'),
      path.join(r, 'tools', 'Git', 'cmd'),
      path.join(r, 'tools', 'uv'),
      path.join(r, 'tools', 'uv', 'bin'),
      path.join(r, 'uvtools', 'bin'),
      path.join(r, 'harness2', '.venv', 'Scripts')
    );
    const appsTools = path.join(r, 'apps', 'tools');
    if (fs.existsSync(appsTools)) {
      try {
        for (const sub of fs.readdirSync(appsTools, { withFileTypes: true })) {
          if (sub.isDirectory()) dirs.push(path.join(appsTools, sub.name));
        }
      } catch (_) {}
    }
  }

  dirs.push(
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd'),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
    'C:\\Program Files\\nodejs',
    'C:\\Program Files\\Git\\cmd',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps')
  );

  const pathEnv = process.env.PATH || process.env.Path || '';
  for (const p of pathEnv.split(path.delimiter)) {
    if (p && p.trim()) dirs.push(p.trim());
  }

  return Array.from(new Set(dirs.filter(Boolean)));
}

function findExecutableSmart(names, options = {}) {
  const { portableRoot = '', forceRefresh = false } = options;
  const cacheKey = `${portableRoot}::${names.join('|')}`;
  const now = Date.now();

  if (!forceRefresh && execCache.has(cacheKey)) {
    const entry = execCache.get(cacheKey);
    if (entry.path && now - entry.ts < EXEC_CACHE_TTL_MS) {
      return entry.path;
    }
  }

  const dirs = getExtraSearchDirs(portableRoot);
  for (const d of dirs) {
    for (const n of names) {
      const full = path.join(d, n);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          execCache.set(cacheKey, { path: full, ts: now });
          return full;
        }
      } catch (_) {}
    }
  }
  return null;
}

function buildEnhancedEnv(portableRoot = '', extraEnv = {}) {
  const extraDirs = getExtraSearchDirs(portableRoot);
  const currentPath = process.env.PATH || process.env.Path || '';
  const mergedPath = Array.from(new Set([...extraDirs, ...currentPath.split(path.delimiter).filter(Boolean)])).join(
    path.delimiter
  );

  const env = {
    ...process.env,
    PATH: mergedPath,
    Path: mergedPath,
    ...extraEnv
  };

  if (portableRoot && fs.existsSync(portableRoot)) {
    const npmDir = path.join(portableRoot, 'npm');
    const uvToolsDir = path.join(portableRoot, 'uvtools');
    if (fs.existsSync(npmDir) || extraEnv.USE_PORTABLE_PREFIX === '1') {
      fs.mkdirSync(npmDir, { recursive: true });
      env.npm_config_prefix = npmDir;
    }
    if (fs.existsSync(uvToolsDir) || extraEnv.USE_PORTABLE_PREFIX === '1') {
      fs.mkdirSync(path.join(uvToolsDir, 'bin'), { recursive: true });
      env.UV_TOOL_DIR = uvToolsDir;
      env.UV_TOOL_BIN_DIR = path.join(uvToolsDir, 'bin');
    }
  }

  return env;
}

function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch (_) {
    try {
      proc.kill();
    } catch (_) {}
  }
}

// ============================================================================
// MULTI-AGENT CLI HUB CATALOG
// ============================================================================
const MULTI_AGENT_CATALOG = [
  {
    id: 'opendocflow',
    name: 'OpenDocFlow Native Agent (@opendocflow)',
    vendor: 'OpenDocFlow v4.0 (Built-In)',
    badge: 'BUILT-IN + MCP',
    installMethod: 'builtin',
    binaries: [],
    wireProtocol: 'OpenAI + Native Tools (:4141/v1)',
    launchCmd: 'internal:agent-studio',
    description: 'Built-in autonomous coding & documentation agent + 7 specialist subagents + native MCP server.'
  },
  {
    id: 'opencode',
    name: 'OpenCode V2 Agent CLI',
    vendor: 'SST / OpenCode',
    badge: 'PRIMARY ENGINE',
    installMethod: 'npm',
    npmPkg: 'opencode-ai@latest',
    binaries: ['opencode.cmd', 'opencode.exe', 'opencode'],
    wireProtocol: 'Native OpenCode Config + :4141/v1',
    launchCmd: 'opencode',
    runJsonSupport: true,
    description: 'Flagship terminal & server coding agent supporting plugins, custom agents, slash commands & MCP.'
  },
  {
    id: 'claude',
    name: 'Claude Code CLI',
    vendor: 'Anthropic',
    badge: 'ANTHROPIC WIRE (:4141)',
    installMethod: 'npm',
    npmPkg: '@anthropic-ai/claude-code@latest',
    binaries: ['claude.cmd', 'claude.exe', 'claude'],
    wireProtocol: 'Anthropic /v1/messages Bridge',
    launchCmd: 'claude',
    description: 'Anthropic agentic coding CLI — routes through OpenDocFlow :4141/v1/messages with any free/paid model!'
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    vendor: 'OpenAI',
    badge: 'OPENAI WIRE (:4141)',
    installMethod: 'npm',
    npmPkg: '@openai/codex@latest',
    binaries: ['codex.cmd', 'codex.exe', 'codex'],
    wireProtocol: 'OpenAI /v1/chat/completions',
    launchCmd: 'codex',
    description: 'Lightweight terminal coding agent — connects to OpenDocFlow Smart Gateway via OPENAI_BASE_URL.'
  },
  {
    id: 'gemini',
    name: 'Google Gemini CLI',
    vendor: 'Google',
    badge: 'FREE 1M CONTEXT',
    installMethod: 'npm',
    npmPkg: '@google/gemini-cli@latest',
    binaries: ['gemini.cmd', 'gemini.exe', 'gemini'],
    wireProtocol: 'GEMINI_API_KEY + Universal Skills',
    launchCmd: 'gemini',
    description: 'Official Google Gemini terminal agent with 1M context window and shared ~/.gemini skills.'
  },
  {
    id: 'qwen',
    name: 'Qwen Code CLI',
    vendor: 'Alibaba Qwen',
    badge: 'QWEN3-CODER AGENT',
    installMethod: 'npm',
    npmPkg: '@qwen-code/qwen-code@latest',
    binaries: ['qwen.cmd', 'qwen.exe', 'qwen'],
    wireProtocol: 'OpenAI /v1/chat/completions (:4141)',
    launchCmd: 'qwen',
    description: 'Purpose-built Qwen3-Coder terminal coding agent wired directly to OpenDocFlow key pools.'
  },
  {
    id: 'aider',
    name: 'Aider AI Pair Programmer',
    vendor: 'Aider',
    badge: 'GIT AUTO-COMMITS',
    installMethod: 'uv',
    uvPkg: 'aider-chat',
    binaries: ['aider.exe', 'aider.cmd', 'aider'],
    wireProtocol: 'OpenAI /v1/chat/completions (:4141)',
    launchCmd: 'aider --openai-api-base http://127.0.0.1:4141/v1 --openai-api-key studio-local-gateway --model openai/auto-coding',
    description: 'Git-native multi-file architect/editor agent pre-configured to run non-stop via :4141/v1.'
  },
  {
    id: 'ollama',
    name: 'Ollama Offline Model Server',
    vendor: 'Ollama',
    badge: '100% OFFLINE GPU/CPU',
    installMethod: 'winget',
    wingetId: 'Ollama.Ollama',
    binaries: ['ollama.exe', 'ollama'],
    wireProtocol: 'http://127.0.0.1:11434/v1',
    launchCmd: 'ollama list',
    description: 'Runs Qwen2.5-Coder, DeepSeek-R1 & Llama locally with zero API quotas or internet needed.'
  }
];

// ============================================================================
// @OPENDOCFLOW SPECIALIST AGENT TEAM & SLASH COMMANDS SUITE
// ============================================================================
const OPENDOCFLOW_AGENT_TEAM = {
  opendocflow: {
    description: 'OpenDocFlow Master Full-Stack, Multi-Model & Documentation Lead Agent',
    mode: 'primary',
    system:
      'You are @opendocflow, the flagship autonomous software engineering and documentation lead agent inside OpenDocFlow v4.0. Build clean, fast, production-grade code with zero placeholders, verify syntax and runtime behavior after every edit, protect secrets (.env), optimize startup/UI speed, and keep documentation synchronized.'
  },
  architect: {
    description: 'Systems Architect — modular design, data flow, trade-offs & Mermaid diagrams (Read-Only)',
    mode: 'subagent',
    readOnly: true,
    system:
      'You are @architect. Inspect the repository structure, identify bottlenecks and coupling, and propose clear, minimal, high-leverage architectures with valid Mermaid diagrams (flowchart LR / sequenceDiagram) and concrete file plans.'
  },
  coder: {
    description: 'Fast Implementation & Refactoring Engineer — clean, zero-placeholder code',
    mode: 'subagent',
    system:
      'You are @coder. Write idiomatic, modular, high-performance code with zero TODOs or fake stubs. Preserve unrelated comments and verify syntax immediately.'
  },
  debugger: {
    description: 'Root-Cause Bug, Freeze, Memory Leak & Performance Hunter',
    mode: 'subagent',
    system:
      'You are @debugger. Trace hangs, event-loop stalls, race conditions, broken IPC/HTTP contracts, and edge-case crashes to their exact root line, apply minimal surgical fixes, and verify resolution.'
  },
  docflow: {
    description: 'Technical Writer — GitHub #1 READMEs, Architecture Docs, API Specs & Changelogs',
    mode: 'subagent',
    system:
      'You are @docflow. Craft crystal-clear, developer-loved README.md files, architecture guides with Mermaid diagrams, API references, and categorized release notes.'
  },
  security: {
    description: 'Security & Secret-Leak Auditor — OWASP, command injection, XSS & auth checks (Read-Only)',
    mode: 'subagent',
    readOnly: true,
    system:
      'You are @security. Audit codebases for secret exposure, command injection, unsafe DOM innerHTML/XSS, path traversal, and missing input validation. Provide severity-ranked findings and exact patches.'
  },
  'reverse-engineer': {
    description: 'Binary, APK, Electron & Web Bundle Reverse Engineering Specialist (REA MCP)',
    mode: 'subagent',
    readOnly: true,
    system:
      'You are @reverse-engineer. Use REA MCP tools and static/dynamic inspection evidence to analyze native binaries, Android APKs, Electron ASAR bundles, and web captures accurately.'
  },
  'graph-navigator': {
    description: 'Codebase Knowledge Graph Explorer (Graphify)',
    mode: 'subagent',
    readOnly: true,
    system:
      'You are @graph-navigator. Prefer querying graphify-out/graph.json and scoped subgraphs before broad file greps to map cross-module dependencies with minimal token usage.'
  }
};

const OPENDOCFLOW_SLASH_COMMANDS = {
  docflow: {
    description: 'Generate or upgrade README.md, Mermaid architecture diagrams, and developer docs',
    template:
      'Use @docflow principles to inspect this repository and generate or upgrade README.md with clear badges, feature matrix, Mermaid architecture diagram, and exact setup/run instructions.'
  },
  pack: {
    description: 'Summarize repository architecture, entrypoints, and module map',
    template:
      'Map the full directory tree, key entrypoints, data/IPC flows, and external dependencies of this project concisely.'
  },
  'fix-fast': {
    description: 'Audit and eliminate freezes, event-loop blocks, UI lag, and runtime bugs',
    template:
      'Find every synchronous bottleneck, memory/process leak, unhandled error, and UI lag source in this project, fix them cleanly, and verify syntax.'
  },
  audit: {
    description: 'Run a security, secret-redaction, XSS, and reliability audit',
    template:
      'Audit this codebase for exposed secrets, XSS/innerHTML injection, shell injection, path traversal, and broken error handling. Report and fix any issues.'
  },
  architect: {
    description: 'Create a step-by-step technical blueprint with Mermaid diagrams before coding',
    template:
      'Design a concise, modular implementation plan with file-by-file responsibilities and a Mermaid flowchart before making code edits.'
  },
  'release-notes': {
    description: 'Generate polished GitHub Release notes from recent git commits',
    template:
      'Inspect recent git log commits and package version, then draft polished GitHub Release notes with Highlights, New Features, Speed Improvements, and Bug Fixes.'
  }
};

// ============================================================================
// CURATED 1-CLICK MCP MARKETPLACE CATALOG (12 TOP SERVERS)
// ============================================================================
const MCP_MARKETPLACE_CATALOG = [
  {
    id: 'opendocflow',
    name: 'OpenDocFlow Native MCP',
    category: 'Built-In Agent & Gateway',
    badge: 'BUILT-IN • 5ms',
    builtinMcp: true,
    description: 'Exposes Smart Gateway health, model rotation, Repo-to-Markdown packager, universal skills & specialist delegation.'
  },
  {
    id: 'context7',
    name: 'Context7 Live Library Docs',
    category: 'Live Documentation',
    badge: 'TOP TRENDING',
    command: ['npx', '-y', '@upstash/context7-mcp@latest'],
    description: 'Fetches up-to-date, version-accurate official documentation and code examples for any framework or SDK.'
  },
  {
    id: 'playwright',
    name: 'Playwright Browser Automation',
    category: 'Web & UI Testing',
    badge: 'OFFICIAL MICROSOFT',
    command: ['npx', '-y', '@playwright/mcp@latest'],
    description: 'Lets agents navigate web apps, inspect DOM accessibility trees, click UI controls, and run E2E tests.'
  },
  {
    id: 'filesystem',
    name: 'ModelContextProtocol Filesystem',
    category: 'Core Workspace',
    badge: 'OFFICIAL MCP',
    command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.'],
    description: 'Fast structured file reading, tree listing, editing, and pattern search for MCP-compatible IDEs.'
  },
  {
    id: 'github',
    name: 'GitHub Official MCP',
    category: 'Git & Releases',
    badge: 'OFFICIAL GITHUB',
    command: ['npx', '-y', '@modelcontextprotocol/server-github'],
    description: 'Manage GitHub repositories, Pull Requests, Issues, Actions workflows, code search, and Releases.'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking Engine',
    category: 'Deep Reasoning',
    badge: 'REASONING BOOST',
    command: ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking'],
    description: 'Adds structured multi-step reflective problem decomposition and hypothesis revision to any coding model.'
  },
  {
    id: 'memory',
    name: 'Persistent Knowledge Graph Memory',
    category: 'Agent Memory',
    badge: 'OFFICIAL MCP',
    command: ['npx', '-y', '@modelcontextprotocol/server-memory'],
    description: 'Stores entities, architecture facts, and user preferences in a persistent local graph across sessions.'
  },
  {
    id: 'fetch',
    name: 'Web Fetch & Markdown Reader',
    category: 'Web Research',
    badge: 'CLEAN MARKDOWN',
    command: ['uvx', 'mcp-server-fetch'],
    description: 'Downloads web pages and API docs and converts HTML into clean, token-efficient Markdown for agents.'
  },
  {
    id: 'git-mcp',
    name: 'Git Repository Inspector MCP',
    category: 'Version Control',
    badge: 'UVX FAST',
    command: ['uvx', 'mcp-server-git'],
    description: 'Structured git diff, blame, log, branch, and commit inspection tools via Python uvx.'
  },
  {
    id: 'sqlite',
    name: 'SQLite Database Explorer',
    category: 'Databases',
    badge: 'SQL + SCHEMA',
    command: ['uvx', 'mcp-server-sqlite', '--db-path', './data.db'],
    description: 'Query local SQLite databases, inspect table schemas, and synthesize analytical insights.'
  },
  {
    id: 'rea',
    name: 'REA (Reverse Engineer Anything)',
    category: 'Reverse Engineering',
    badge: '229 RE TOOLS',
    command: ['npx', '-y', 'rea-agents@latest', 'mcp'],
    description: 'Static & dynamic binary, APK, Electron ASAR, Mach-O/PE, Frida, and web bundle reverse engineering suite.'
  },
  {
    id: 'graphify-mcp',
    name: 'Graphify Codebase Graph MCP',
    category: 'Code Intelligence',
    badge: 'LOCAL GRAPH',
    command: ['graphify-mcp'],
    description: 'Queries persistent AST/dependency code graphs so agents understand large repos using 80% fewer tokens.'
  }
];

function getAgentsHubState(options = {}) {
  const { portableRoot = '' } = options;
  return MULTI_AGENT_CATALOG.map((agent) => {
    if (agent.installMethod === 'builtin') {
      return {
        ...agent,
        installed: true,
        binaryPath: 'Built-in OpenDocFlow Engine + mcp/opendocflow-mcp.mjs'
      };
    }
    const bin = findExecutableSmart(agent.binaries, { portableRoot });
    return {
      ...agent,
      installed: Boolean(bin),
      binaryPath: bin || ''
    };
  });
}

/**
 * Turbo Parallel Installer: batches npm global installs together and runs winget + npm + uv lanes concurrently!
 */
async function runTurboParallelInstall(ids = [], options = {}) {
  const { portableRoot = '', usePortablePrefix = false, onLog = () => {}, onProgress = () => {} } = options;
  const env = buildEnhancedEnv(portableRoot, usePortablePrefix ? { USE_PORTABLE_PREFIX: '1' } : {});

  function spawnLogged(label, cmd, args) {
    return new Promise((resolve) => {
      onLog(`\n⚡ [${label}] $ ${cmd} ${args.join(' ')}\n`, 'cmd');
      const child = spawn(cmd, args, {
        cwd: os.homedir(),
        shell: true,
        windowsHide: true,
        env
      });
      let out = '';
      child.stdout.on('data', (d) => {
        const s = d.toString();
        out += s;
        onLog(s, 'stdout');
      });
      child.stderr.on('data', (d) => {
        const s = d.toString();
        out += s;
        onLog(s, 'stderr');
      });
      child.on('error', (err) => {
        onLog(`\n[${label} error: ${err.message}]\n`, 'stderr');
        resolve({ ok: false, code: -1, output: out });
      });
      child.on('close', (code) => {
        onLog(`\n✓ [${label} finished with exit code ${code}]\n`, 'meta');
        resolve({ ok: code === 0, code, output: out });
      });
    });
  }

  const uniqueIds = Array.from(new Set(ids));
  const wingetTasks = [];
  const npmPackages = [];
  const npmItemIds = [];
  const uvTasks = [];
  const postTasks = [];

  const wingetMap = {
    node: { id: 'OpenJS.NodeJS.LTS', label: 'Node.js LTS' },
    git: { id: 'Git.Git', label: 'Git for Windows' },
    uv: { id: 'astral-sh.uv', label: 'Astral uv + Python' },
    adb: { id: 'Google.PlatformTools', label: 'Android SDK Platform-Tools (ADB)' },
    wt: { id: 'Microsoft.WindowsTerminal', label: 'Windows Terminal' },
    ollama: { id: 'Ollama.Ollama', label: 'Ollama Local Server' }
  };

  const npmMap = {
    opencode: 'opencode-ai@latest',
    claude: '@anthropic-ai/claude-code@latest',
    codex: '@openai/codex@latest',
    gemini: '@google/gemini-cli@latest',
    qwen: '@qwen-code/qwen-code@latest',
    rea: 'rea-agents@latest'
  };

  for (const id of uniqueIds) {
    onProgress({ id, state: 'queued' });
    if (wingetMap[id]) {
      wingetTasks.push({ id, ...wingetMap[id] });
    } else if (npmMap[id]) {
      npmPackages.push(npmMap[id]);
      npmItemIds.push(id);
    } else if (id === 'graphify') {
      uvTasks.push({ id: 'graphify', pkg: 'graphifyy' });
      postTasks.push(async () => {
        await spawnLogged('Graphify Skill Hook', 'graphify', ['install', '--platform', 'opencode']);
      });
    } else if (id === 'aider') {
      uvTasks.push({ id: 'aider', pkg: 'aider-chat' });
    }
  }

  const results = {};

  // Phase 1: If core runtimes (node, git, uv) were requested, install them in parallel first so npm/uv exist!
  const coreRuntimeTasks = wingetTasks.filter((t) => ['node', 'git', 'uv'].includes(t.id));
  const otherWingetTasks = wingetTasks.filter((t) => !['node', 'git', 'uv'].includes(t.id));

  if (coreRuntimeTasks.length > 0) {
    await Promise.all(
      coreRuntimeTasks.map(async (t) => {
        onProgress({ id: t.id, state: 'installing' });
        const args = [
          'install',
          '--id',
          t.id === 'node' ? 'OpenJS.NodeJS.LTS' : t.id === 'git' ? 'Git.Git' : 'astral-sh.uv',
          '-e',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ];
        const r = await spawnLogged(t.label, 'winget', args);
        results[t.id] = r.ok;
        onProgress({ id: t.id, state: r.ok ? 'done' : 'failed' });
      })
    );
    clearExecCache();
  }

  // Phase 2: Run remaining winget installs + SINGLE BATCHED npm install + uv tool installs ALL IN PARALLEL!
  const parallelLanes = [];

  if (npmPackages.length > 0) {
    parallelLanes.push(
      (async () => {
        npmItemIds.forEach((id) => onProgress({ id, state: 'installing' }));
        const npmArgs = ['install', '-g', ...npmPackages, '--no-audit', '--no-fund', '--prefer-online'];
        if (usePortablePrefix && portableRoot) {
          const prefixDir = path.join(portableRoot, 'npm');
          fs.mkdirSync(prefixDir, { recursive: true });
          npmArgs.splice(2, 0, '--prefix', `"${prefixDir}"`);
        }
        const r = await spawnLogged(`Turbo Batch NPM (${npmPackages.length} tools)`, 'npm', npmArgs);
        npmItemIds.forEach((id) => {
          results[id] = r.ok;
          onProgress({ id, state: r.ok ? 'done' : 'failed' });
        });
      })()
    );
  }

  for (const wt of otherWingetTasks) {
    parallelLanes.push(
      (async () => {
        onProgress({ id: wt.id, state: 'installing' });
        const r = await spawnLogged(wt.label, 'winget', [
          'install',
          '--id',
          wt.id === 'adb'
            ? 'Google.PlatformTools'
            : wt.id === 'wt'
            ? 'Microsoft.WindowsTerminal'
            : 'Ollama.Ollama',
          '-e',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements'
        ]);
        results[wt.id] = r.ok;
        onProgress({ id: wt.id, state: r.ok ? 'done' : 'failed' });
      })()
    );
  }

  for (const ut of uvTasks) {
    parallelLanes.push(
      (async () => {
        onProgress({ id: ut.id, state: 'installing' });
        const r = await spawnLogged(`uv tool (${ut.pkg})`, 'uv', ['tool', 'install', ut.pkg]);
        results[ut.id] = r.ok;
        onProgress({ id: ut.id, state: r.ok ? 'done' : 'failed' });
      })()
    );
  }

  await Promise.all(parallelLanes);

  for (const fn of postTasks) {
    await fn();
  }

  clearExecCache();
  return {
    ok: Object.values(results).every(Boolean),
    results
  };
}

module.exports = {
  clearExecCache,
  detectDefaultPortableRoot,
  getExtraSearchDirs,
  findExecutableSmart,
  buildEnhancedEnv,
  killProcessTree,
  MULTI_AGENT_CATALOG,
  OPENDOCFLOW_AGENT_TEAM,
  OPENDOCFLOW_SLASH_COMMANDS,
  MCP_MARKETPLACE_CATALOG,
  getAgentsHubState,
  runTurboParallelInstall
};
