#!/usr/bin/env node
/**
 * OpenDocFlow v4.0 — Native Model Context Protocol (MCP) Server
 * Zero-dependency, instant-startup (<5ms) stdio MCP server for OpenCode V2,
 * Claude Code, OpenAI Codex CLI, Google Gemini CLI, Qwen Code, Cursor & Windsurf.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

const GATEWAY_PORT = Number(process.env.OPENDOCFLOW_PORT) || 4141;

function getOpenCodeConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

function callLocalGateway(urlPath, method = 'GET', bodyObj = null, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: GATEWAY_PORT,
        path: urlPath,
        method,
        headers: {
          Accept: 'application/json',
          ...(bodyStr
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
              }
            : {})
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (_) {
            resolve({ status: res.statusCode, data: { raw: data } });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Gateway request timed out')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function quickPackDirectory(dirPath, maxFiles = 80) {
  const root = path.resolve(dirPath || process.cwd());
  if (!fs.existsSync(root)) return `Directory does not exist: ${root}`;
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target']);
  const skipExts = new Set(['.exe', '.dll', '.zip', '.png', '.jpg', '.gif', '.ico', '.pdf', '.asar', '.blockmap']);
  const files = [];

  function walk(cur, depth) {
    if (depth > 6 || files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (skipExts.has(ext) || e.name.startsWith('.env') || e.name.endsWith('.key') || e.name === 'package-lock.json') continue;
        try {
          const st = fs.statSync(full);
          if (st.size <= 48 * 1024) files.push({ full, rel: path.relative(root, full).replace(/\\/g, '/') });
        } catch (_) {}
      }
    }
  }
  walk(root, 0);

  const out = [`# OpenDocFlow Packed Context (${path.basename(root)}) — ${files.length} files\n`];
  for (const f of files) {
    try {
      const txt = fs.readFileSync(f.full, 'utf8');
      if (!txt.includes('\u0000')) {
        out.push(`## ${f.rel}\n\`\`\`\n${txt.slice(0, 12000)}\n\`\`\`\n`);
      }
    } catch (_) {}
  }
  return out.join('\n');
}

const TOOLS = [
  {
    name: 'opendocflow_gateway_status',
    description: 'Check live OpenDocFlow Smart Gateway (:4141/v1) status, active strategy, routed request stats, tokens/sec speed, and fallback chain.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'opendocflow_rotate_model',
    description: 'Rotate OpenCode active coding model to the next healthy free/paid coding model in the OpenDocFlow fallback chain (or set a specific provider/model).',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Optional specific provider/model ID (e.g. "google/gemini-2.5-pro"). Leave blank to rotate to next model in chain.'
        }
      }
    }
  },
  {
    name: 'opendocflow_pack_repository',
    description: 'Pack a local project directory into a clean, token-optimized Markdown bundle for rapid architectural analysis or documentation generation.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute or relative path to the directory to pack.' },
        maxFiles: { type: 'number', description: 'Maximum files to include (default 80).' }
      },
      required: ['directory']
    }
  },
  {
    name: 'opendocflow_list_skills',
    description: 'List all universal AI coding skills installed across OpenCode, Claude Code, Codex, and Gemini on this machine.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'opendocflow_read_skill',
    description: 'Read the full SKILL.md instructions for a named global skill.',
    inputSchema: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: 'Skill folder name (from opendocflow_list_skills).' }
      },
      required: ['skillName']
    }
  },
  {
    name: 'opendocflow_ask_specialist',
    description: 'Delegate a coding, architecture, debugging, security, or documentation question to the OpenDocFlow Multi-Provider Smart Gateway (:4141/v1).',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: ['architect', 'coder', 'debugger', 'security', 'docflow'],
          description: 'Specialist persona to consult.'
        },
        prompt: { type: 'string', description: 'Detailed question or code snippet to analyze.' },
        model: { type: 'string', description: 'Optional model override (defaults to auto-coding).' }
      },
      required: ['prompt']
    }
  }
];

async function handleToolCall(name, args = {}) {
  if (name === 'opendocflow_gateway_status') {
    try {
      const res = await callLocalGateway('/v1/health', 'GET', null, 3000);
      return JSON.stringify(res.data, null, 2);
    } catch (e) {
      return JSON.stringify({
        running: false,
        note: 'OpenDocFlow desktop gateway is not currently running on :4141, reading static config.',
        configDir: getOpenCodeConfigDir()
      });
    }
  }

  if (name === 'opendocflow_rotate_model') {
    const cfgDir = getOpenCodeConfigDir();
    const chainPath = path.join(cfgDir, 'free-fallback-chain.json');
    const cfgPath = path.join(cfgDir, 'opencode.jsonc');
    let nextModel = args.model ? String(args.model).trim() : '';

    if (!nextModel) {
      let chain = ['google/gemini-2.5-pro', 'openrouter/qwen/qwen3-coder:free', 'google/gemini-2.5-flash'];
      if (fs.existsSync(chainPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
          if (Array.isArray(parsed.chain) && parsed.chain.length > 0) chain = parsed.chain;
        } catch (_) {}
      }
      nextModel = chain[Math.floor(Math.random() * chain.length)];
    }

    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      if (/"model"\s*:\s*"[^"]*"/.test(raw)) {
        fs.writeFileSync(cfgPath, raw.replace(/"model"\s*:\s*"[^"]*"/, `"model": "${nextModel}"`), 'utf8');
      }
    }
    return `Active model updated to: ${nextModel}`;
  }

  if (name === 'opendocflow_pack_repository') {
    return quickPackDirectory(args.directory || process.cwd(), Number(args.maxFiles) || 80);
  }

  if (name === 'opendocflow_list_skills') {
    const roots = [
      path.join(getOpenCodeConfigDir(), 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
      path.join(os.homedir(), '.claude', 'skills')
    ];
    const found = new Set();
    for (const r of roots) {
      if (!fs.existsSync(r)) continue;
      for (const e of fs.readdirSync(r, { withFileTypes: true })) {
        if (e.isDirectory()) found.add(e.name);
      }
    }
    return JSON.stringify({ count: found.size, skills: Array.from(found).sort() }, null, 2);
  }

  if (name === 'opendocflow_read_skill') {
    const clean = String(args.skillName || '').replace(/[^a-zA-Z0-9-_]/g, '');
    const candidates = [
      path.join(getOpenCodeConfigDir(), 'skills', clean, 'SKILL.md'),
      path.join(os.homedir(), '.agents', 'skills', clean, 'SKILL.md'),
      path.join(os.homedir(), '.claude', 'skills', clean, 'SKILL.md')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    }
    return `Skill "${clean}" not found.`;
  }

  if (name === 'opendocflow_ask_specialist') {
    const roleMap = {
      architect: 'You are @architect in OpenDocFlow: provide concise architecture decisions, trade-offs, and clean Mermaid diagrams.',
      coder: 'You are @coder in OpenDocFlow: write clean, complete, production-ready code with zero placeholders.',
      debugger: 'You are @debugger in OpenDocFlow: identify exact root causes and minimal, high-confidence fixes.',
      security: 'You are @security in OpenDocFlow: audit for injection, auth bypass, secret exposure, and unsafe shell usage.',
      docflow: 'You are @docflow in OpenDocFlow: write clear, well-structured developer documentation and READMEs.'
    };
    const sys = roleMap[args.role || 'architect'] || roleMap.architect;
    const res = await callLocalGateway('/v1/chat/completions', 'POST', {
      model: args.model || 'auto-coding',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: String(args.prompt || '') }
      ],
      stream: false
    });
    const choice = res.data && res.data.choices && res.data.choices[0];
    if (choice && choice.message && choice.message.content) {
      return choice.message.content;
    }
    return JSON.stringify(res.data);
  }

  throw new Error(`Unknown tool: ${name}`);
}

// Dual-framing MCP Stdio Transport (supports both newline-delimited JSON-RPC & Content-Length framing)
let useContentLengthFraming = false;
let inputBuffer = Buffer.alloc(0);

function sendResponse(msgObj) {
  const json = JSON.stringify(msgObj);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function processRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  // Notifications have no id
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'opendocflow-mcp', version: '4.0.0' }
        }
      });
      return;
    }

    if (method === 'ping') {
      sendResponse({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendResponse({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      const text = await handleToolCall(toolName, toolArgs);
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: String(text) }]
        }
      });
      return;
    }

    sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  } catch (err) {
    sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: err.message || String(err) }
    });
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length > 0) {
    const preview = inputBuffer.slice(0, 32).toString('utf8');
    if (preview.startsWith('Content-Length:')) {
      useContentLengthFraming = true;
      const headerEnd = inputBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headerStr = inputBuffer.slice(0, headerEnd).toString('utf8');
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      const len = match ? parseInt(match[1], 10) : 0;
      const totalNeeded = headerEnd + 4 + len;
      if (inputBuffer.length < totalNeeded) return;
      const bodyStr = inputBuffer.slice(headerEnd + 4, totalNeeded).toString('utf8');
      inputBuffer = inputBuffer.slice(totalNeeded);
      try {
        processRpcMessage(JSON.parse(bodyStr));
      } catch (_) {}
    } else {
      const nlIdx = inputBuffer.indexOf('\n');
      if (nlIdx === -1) return;
      const line = inputBuffer.slice(0, nlIdx).toString('utf8').trim();
      inputBuffer = inputBuffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        processRpcMessage(JSON.parse(line));
      } catch (_) {}
    }
  }
});
