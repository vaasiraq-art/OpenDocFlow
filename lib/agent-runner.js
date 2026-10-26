'use strict';

const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const { NATIVE_AGENT_TOOLS, executeNativeAgentTool } = require('./docflow-engine');
const { OPENDOCFLOW_AGENT_TEAM, buildEnhancedEnv, killProcessTree } = require('./agents-installer');

let activeClientReqs = [];
let activeAgentChild = null;
let abortedFlag = false;

function abortActiveAgentRun() {
  abortedFlag = true;
  for (const r of activeClientReqs) {
    try {
      r.destroy();
    } catch (_) {}
  }
  activeClientReqs = [];
  if (activeAgentChild) {
    killProcessTree(activeAgentChild);
    activeAgentChild = null;
  }
}

function callGatewayJson(port, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...bodyObj, stream: false });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 55000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          activeClientReqs = activeClientReqs.filter((x) => x !== req);
          try {
            resolve({
              status: res.statusCode || 500,
              routedModel: res.headers['x-studio-routed-model'] || bodyObj.model || 'auto-coding',
              data: JSON.parse(data)
            });
          } catch (e) {
            reject(new Error(data.slice(0, 220) || e.message));
          }
        });
      }
    );
    activeClientReqs.push(req);
    req.on('error', (err) => {
      activeClientReqs = activeClientReqs.filter((x) => x !== req);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy(new Error('Gateway request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

function streamGatewaySse(port, bodyObj, onDelta, slot = 'main') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...bodyObj, stream: true });
    const t0 = Date.now();
    let ttftMs = 0;
    let totalText = '';

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 65000
      },
      (res) => {
        const routedModel = res.headers['x-studio-routed-model'] || bodyObj.model || 'auto-coding';
        if ((res.statusCode || 500) >= 400) {
          let errStr = '';
          res.on('data', (c) => (errStr += c.toString()));
          res.on('end', () => {
            activeClientReqs = activeClientReqs.filter((x) => x !== req);
            try {
              const j = JSON.parse(errStr);
              reject(new Error((j.error && j.error.message) || errStr.slice(0, 260)));
            } catch (_) {
              reject(new Error(errStr.slice(0, 260) || `HTTP ${res.statusCode}`));
            }
          });
          return;
        }

        let buf = '';
        res.on('data', (chunk) => {
          if (abortedFlag) return;
          if (!ttftMs) ttftMs = Date.now() - t0;
          buf += chunk.toString('utf8');
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const parsed = JSON.parse(raw);
              const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
              const txt = (delta && (delta.content || delta.reasoning_content)) || '';
              if (txt) {
                totalText += txt;
                const elapsedSec = Math.max(0.05, (Date.now() - t0) / 1000);
                const tokPerSec = Math.round((Math.ceil(totalText.length / 4) / elapsedSec) * 10) / 10;
                onDelta({ slot, text: txt, model: routedModel, tokPerSec, ttftMs });
              }
            } catch (_) {}
          }
        });

        res.on('end', () => {
          activeClientReqs = activeClientReqs.filter((x) => x !== req);
          const totalMs = Math.max(1, Date.now() - t0);
          const tokPerSec = Math.round((Math.max(1, Math.ceil(totalText.length / 4)) / (totalMs / 1000)) * 10) / 10;
          resolve({ text: totalText, model: routedModel, ttftMs: ttftMs || totalMs, totalMs, tokPerSec });
        });
      }
    );

    activeClientReqs.push(req);
    req.on('error', (err) => {
      activeClientReqs = activeClientReqs.filter((x) => x !== req);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy(new Error('Stream timed out'));
    });
    req.write(payload);
    req.end();
  });
}

async function runAgentTurn(payload = {}, helpers = {}) {
  const {
    engine = 'opendocflow', // 'opendocflow' | 'opencode' | 'cli' | 'arena'
    cliId = 'opencode',
    persona = 'opendocflow',
    model = 'auto-coding',
    arenaModelB = 'openrouter/qwen/qwen3-coder:free',
    prompt = '',
    history = [],
    workspaceDir = '',
    enableTools = true,
    allowWrite = true,
    sessionId = `sess_${Date.now()}`
  } = payload;

  const { gatewayPort = 4141, portableRoot = '', emit = () => {} } = helpers;
  abortedFlag = false;

  const cwd = workspaceDir && workspaceDir.trim() ? workspaceDir.trim() : os.homedir();
  const personaDef = OPENDOCFLOW_AGENT_TEAM[persona] || OPENDOCFLOW_AGENT_TEAM.opendocflow;
  const effectiveAllowWrite = personaDef.readOnly ? false : Boolean(allowWrite);

  // --------------------------------------------------------------------------
  // MODE 1: SIDE-BY-SIDE DUAL-MODEL ARENA
  // --------------------------------------------------------------------------
  if (engine === 'arena') {
    const modelA = model || 'google/gemini-2.5-pro';
    const modelB = arenaModelB || 'openrouter/qwen/qwen3-coder:free';
    const sysMsg = { role: 'system', content: personaDef.system };
    const msgs = [sysMsg, ...history.slice(-8), { role: 'user', content: prompt }];

    emit({ sessionId, type: 'status', text: `Arena racing ${modelA} vs ${modelB}…` });

    const [resA, resB] = await Promise.allSettled([
      streamGatewaySse(gatewayPort, { model: modelA, messages: msgs }, (d) => emit({ sessionId, type: 'delta', ...d }), 'A'),
      streamGatewaySse(gatewayPort, { model: modelB, messages: msgs }, (d) => emit({ sessionId, type: 'delta', ...d }), 'B')
    ]);

    emit({
      sessionId,
      type: 'done',
      arena: true,
      resultA: resA.status === 'fulfilled' ? resA.value : { error: resA.reason.message },
      resultB: resB.status === 'fulfilled' ? resB.value : { error: resB.reason.message }
    });
    return { ok: true, sessionId };
  }

  // --------------------------------------------------------------------------
  // MODE 2: OPENCODE V2 CLI ENGINE OR MULTI-AGENT CLI DISPATCH
  // --------------------------------------------------------------------------
  if (engine === 'opencode' || engine === 'cli') {
    const targetCli = engine === 'opencode' ? 'opencode' : cliId;
    const env = buildEnhancedEnv(portableRoot, {
      OPENAI_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      OPENAI_API_BASE: `http://127.0.0.1:${gatewayPort}/v1`,
      OPENAI_API_KEY: 'studio-local-gateway',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
      ANTHROPIC_API_KEY: 'studio-local-gateway'
    });

    let cmd = targetCli;
    let args = [];
    const escapedPrompt = JSON.stringify(prompt);

    if (targetCli === 'opencode') {
      args = ['run'];
      if (effectiveAllowWrite) args.push('--auto');
      if (model && model !== 'auto-coding') args.push('--model', model);
      if (persona && persona !== 'opendocflow') args.push('--agent', persona);
      args.push(escapedPrompt);
    } else if (targetCli === 'gemini' || targetCli === 'qwen' || targetCli === 'claude') {
      args = ['-p', escapedPrompt];
    } else if (targetCli === 'codex') {
      args = ['exec', escapedPrompt];
    } else if (targetCli === 'aider') {
      args = [
        '--yes-always',
        '--openai-api-base',
        `http://127.0.0.1:${gatewayPort}/v1`,
        '--openai-api-key',
        'studio-local-gateway',
        '--model',
        'openai/auto-coding',
        '--message',
        escapedPrompt
      ];
    }

    emit({ sessionId, type: 'status', text: `Running ${targetCli} in ${cwd}…` });

    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd,
        shell: true,
        windowsHide: true,
        env
      });
      activeAgentChild = child;
      let combined = '';

      const cleanAnsi = (s) => String(s).replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

      child.stdout.on('data', (d) => {
        const txt = cleanAnsi(d.toString());
        combined += txt;
        emit({ sessionId, type: 'delta', slot: 'main', text: txt, model: `${targetCli}-cli` });
      });
      child.stderr.on('data', (d) => {
        const txt = cleanAnsi(d.toString());
        if (txt.trim()) {
          emit({ sessionId, type: 'delta', slot: 'main', text: txt, model: `${targetCli}-cli` });
        }
      });
      child.on('error', (err) => {
        activeAgentChild = null;
        emit({ sessionId, type: 'error', text: err.message });
        resolve({ ok: false, error: err.message });
      });
      child.on('close', (code) => {
        if (activeAgentChild === child) activeAgentChild = null;
        emit({ sessionId, type: 'done', model: `${targetCli}-cli`, exitCode: code, text: combined });
        resolve({ ok: code === 0, sessionId });
      });
    });
  }

  // --------------------------------------------------------------------------
  // MODE 3: BUILT-IN OPENDOCFLOW AUTONOMOUS AGENT (WITH WORKSPACE TOOLS + SSE)
  // --------------------------------------------------------------------------
  const sysPrompt = [
    personaDef.system,
    `Current Workspace Directory: ${cwd}`,
    effectiveAllowWrite
      ? 'Workspace tools are enabled (read & write allowed). Inspect files before editing when working on a codebase.'
      : 'Read-Only mode is active: inspect files and propose code without modifying disk.'
  ].join('\n');

  const messages = [{ role: 'system', content: sysPrompt }, ...history.slice(-10), { role: 'user', content: prompt }];

  try {
    // Autonomous tool loop (up to 4 tool rounds if workspace tools are enabled)
    if (enableTools && workspaceDir && workspaceDir.trim()) {
      for (let step = 0; step < 4; step++) {
        if (abortedFlag) break;
        emit({ sessionId, type: 'status', text: step === 0 ? 'Thinking & checking workspace tools…' : `Executing agent step ${step + 1}…` });

        let stepRes;
        try {
          stepRes = await callGatewayJson(gatewayPort, {
            model: model || 'auto-coding',
            messages,
            tools: NATIVE_AGENT_TOOLS
          });
        } catch (_) {
          // Provider doesn't support `tools` parameter — fall through directly to streaming completion!
          break;
        }

        if (stepRes.status >= 400 || !stepRes.data || !stepRes.data.choices) {
          break;
        }

        const choice = stepRes.data.choices[0] || {};
        const assistantMsg = choice.message || {};
        const toolCalls = assistantMsg.tool_calls;

        if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
          // Model finished without needing more tools: emit its text smoothly and finish!
          const content = assistantMsg.content || '';
          if (content) {
            emit({
              sessionId,
              type: 'delta',
              slot: 'main',
              text: content,
              model: stepRes.routedModel
            });
            emit({ sessionId, type: 'done', model: stepRes.routedModel, text: content });
            return { ok: true, sessionId, text: content, model: stepRes.routedModel };
          }
          break;
        }

        messages.push({
          role: 'assistant',
          content: assistantMsg.content || null,
          tool_calls: toolCalls
        });

        for (const tc of toolCalls) {
          if (abortedFlag) break;
          const fnName = (tc.function && tc.function.name) || 'unknown';
          let fnArgs = {};
          try {
            fnArgs = JSON.parse((tc.function && tc.function.arguments) || '{}');
          } catch (_) {}

          emit({
            sessionId,
            type: 'tool',
            toolName: fnName,
            toolArgs: fnArgs,
            status: 'running'
          });

          const toolResult = await executeNativeAgentTool(fnName, fnArgs, {
            workspaceDir: cwd,
            allowWrite: effectiveAllowWrite
          });

          emit({
            sessionId,
            type: 'tool',
            toolName: fnName,
            toolArgs: fnArgs,
            toolResult: String(toolResult).slice(0, 600),
            status: 'done'
          });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id || `call_${step}`,
            content: String(toolResult).slice(0, 14000)
          });
        }
      }
    }

    // Stream final response live via SSE
    emit({ sessionId, type: 'status', text: 'Streaming live response…' });
    const finalStream = await streamGatewaySse(
      gatewayPort,
      { model: model || 'auto-coding', messages },
      (delta) => emit({ sessionId, type: 'delta', ...delta }),
      'main'
    );

    emit({
      sessionId,
      type: 'done',
      model: finalStream.model,
      tokPerSec: finalStream.tokPerSec,
      ttftMs: finalStream.ttftMs,
      totalMs: finalStream.totalMs,
      text: finalStream.text
    });
    return { ok: true, sessionId, ...finalStream };
  } catch (err) {
    if (abortedFlag) {
      emit({ sessionId, type: 'done', aborted: true, text: '\n\n*[Stopped by user]*' });
      return { ok: false, aborted: true };
    }
    emit({ sessionId, type: 'error', text: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = {
  runAgentTurn,
  abortActiveAgentRun
};
