'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

function translateAnthropicRequestToOpenAI(anthBody) {
  const messages = [];
  if (anthBody.system) {
    const sysText = Array.isArray(anthBody.system)
      ? anthBody.system.map((b) => b.text || '').join('\n')
      : String(anthBody.system);
    if (sysText.trim()) messages.push({ role: 'system', content: sysText });
  }

  for (const m of anthBody.messages || []) {
    if (!Array.isArray(m.content)) {
      messages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '')
      });
      continue;
    }

    const textParts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of m.content) {
      if (!block) continue;
      if (block.type === 'text') {
        textParts.push(block.text || '');
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        });
      } else if (block.type === 'tool_result') {
        const resContent = Array.isArray(block.content)
          ? block.content.map((c) => c.text || JSON.stringify(c)).join('\n')
          : typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content || '');
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || 'call_0',
          content: resContent
        });
      }
    }

    if (m.role === 'assistant') {
      const assistantMsg = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);
    } else {
      if (textParts.length > 0) {
        messages.push({ role: 'user', content: textParts.join('\n') });
      }
      for (const tr of toolResults) messages.push(tr);
    }
  }

  const out = {
    model: anthBody.model || 'auto-coding',
    messages,
    max_tokens: anthBody.max_tokens || 4096,
    stream: Boolean(anthBody.stream)
  };
  if (anthBody.temperature !== undefined) out.temperature = anthBody.temperature;

  if (Array.isArray(anthBody.tools) && anthBody.tools.length > 0) {
    out.tools = anthBody.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }));
  }

  return out;
}

function translateOpenAIResponseToAnthropic(openAiBuffer, routedModel) {
  let parsed = {};
  try {
    parsed = JSON.parse(openAiBuffer.toString('utf8'));
  } catch (_) {}
  const choice = (parsed.choices && parsed.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];

  if (msg.content) {
    content.push({ type: 'text', text: String(msg.content) });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let inputObj = {};
      try {
        inputObj = JSON.parse((tc.function && tc.function.arguments) || '{}');
      } catch (_) {}
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Date.now()}`,
        name: (tc.function && tc.function.name) || 'tool',
        input: inputObj
      });
    }
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const hasToolUse = content.some((b) => b.type === 'tool_use');
  return Buffer.from(
    JSON.stringify({
      id: parsed.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: routedModel,
      content,
      stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: (parsed.usage && parsed.usage.prompt_tokens) || 0,
        output_tokens: (parsed.usage && parsed.usage.completion_tokens) || 0
      }
    })
  );
}

function sendCachedAsSse(res, openAiJsonBuffer, routedModel, isAnthropicWire) {
  let parsed = {};
  try {
    parsed = JSON.parse(openAiJsonBuffer.toString('utf8'));
  } catch (_) {}
  const choice = (parsed.choices && parsed.choices[0]) || {};
  const msg = choice.message || {};
  const text = msg.content || '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Studio-Routed-Model': routedModel,
    'X-Studio-Cache': 'HIT'
  });

  if (isAnthropicWire) {
    const msgId = `msg_${Date.now()}`;
    res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: routedModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } }
      })}\n\n`
    );
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
    if (text) {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
    }
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: Math.ceil(text.length / 4) } })}\n\n`);
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    res.end();
    return;
  }

  const chunk = {
    id: parsed.id || `chatcmpl_${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: routedModel,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: text,
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {})
        },
        finish_reason: choice.finish_reason || 'stop'
      }
    ]
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function buildProviderHeaders(candidate, payloadByteLen) {
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': payloadByteLen,
    'User-Agent': 'OpenDocFlow/4.0.0'
  };
  if (candidate.apiKey) {
    headers['Authorization'] = `Bearer ${candidate.apiKey}`;
  }
  if (candidate.providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/vaasiraq-art/OpenDocFlow';
    headers['X-Title'] = 'OpenDocFlow AI Agent Studio';
  }
  return headers;
}

/**
 * Attempt an upstream chat completion.
 * - If `streamRequested === false`, buffers JSON and returns `{ ok, status, body, ttftMs, totalMs, estOutTokens }`.
 * - If `streamRequested === true`:
 *    - If upstream status !== 200, reads error body WITHOUT writing to `clientRes` so caller can failover seamlessly!
 *    - If upstream status === 200, pipes live SSE tokens directly to `clientRes` (supporting both OpenAI & Anthropic SSE wire formats!).
 */
function executeUpstreamCandidate(candidate, openAiBody, options = {}) {
  const { streamRequested = false, isAnthropicWire = false, clientRes = null, timeoutMs = 45000 } = options;

  return new Promise((resolve) => {
    let targetUrl;
    try {
      targetUrl = new URL(candidate.baseURL.replace(/\/+$/, '') + '/chat/completions');
    } catch (err) {
      resolve({ ok: false, status: 400, errorText: err.message });
      return;
    }

    const reqBodyObj = {
      ...openAiBody,
      model: candidate.modelId,
      stream: Boolean(streamRequested)
    };
    const payload = JSON.stringify(reqBodyObj);
    const isHttps = targetUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = buildProviderHeaders(candidate, Buffer.byteLength(payload));

    const t0 = Date.now();
    let ttftMs = 0;

    const req = lib.request(
      targetUrl,
      {
        method: 'POST',
        headers,
        timeout: candidate.localNoKey ? 5000 : timeoutMs
      },
      (upRes) => {
        const status = upRes.statusCode || 500;

        // Non-2xx: buffer error body without touching clientRes so failover works 100% cleanly
        if (status < 200 || status >= 300) {
          const errChunks = [];
          upRes.on('data', (c) => errChunks.push(c));
          upRes.on('end', () => {
            resolve({
              ok: false,
              status,
              ttftMs: Date.now() - t0,
              totalMs: Date.now() - t0,
              errorText: Buffer.concat(errChunks).toString('utf8').slice(0, 500)
            });
          });
          return;
        }

        // 2xx + Real-Time SSE Streaming directly to clientRes
        if (streamRequested && clientRes) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Studio-Routed-Model': candidate.fullRef
          });

          let charCount = 0;
          let sseRemainder = '';
          let anthStarted = false;

          if (isAnthropicWire) {
            anthStarted = true;
            clientRes.write(
              `event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: {
                  id: `msg_${Date.now()}`,
                  type: 'message',
                  role: 'assistant',
                  model: candidate.fullRef,
                  content: [],
                  usage: { input_tokens: 0, output_tokens: 0 }
                }
              })}\n\n`
            );
            clientRes.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
              })}\n\n`
            );
          }

          upRes.on('data', (chunk) => {
            if (!ttftMs) ttftMs = Date.now() - t0;
            const str = chunk.toString('utf8');

            if (!isAnthropicWire) {
              // Fast 0ms OpenAI SSE passthrough + token counting
              clientRes.write(chunk);
              const contentMatches = str.match(/"content"\s*:\s*"([^"]*)"/g);
              if (contentMatches) {
                for (const m of contentMatches) charCount += Math.max(1, m.length - 12);
              }
              return;
            }

            // Live OpenAI SSE -> Anthropic SSE bridge for Claude Code
            sseRemainder += str;
            const lines = sseRemainder.split(/\r?\n/);
            sseRemainder = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const dataPart = trimmed.slice(5).trim();
              if (!dataPart || dataPart === '[DONE]') continue;
              try {
                const j = JSON.parse(dataPart);
                const delta = j.choices && j.choices[0] && j.choices[0].delta;
                if (delta && delta.content) {
                  charCount += delta.content.length;
                  clientRes.write(
                    `event: content_block_delta\ndata: ${JSON.stringify({
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: delta.content }
                    })}\n\n`
                  );
                }
              } catch (_) {}
            }
          });

          upRes.on('end', () => {
            const totalMs = Math.max(1, Date.now() - t0);
            if (!ttftMs) ttftMs = totalMs;
            const estOutTokens = Math.max(1, Math.ceil(charCount / 4));

            if (isAnthropicWire && anthStarted) {
              clientRes.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
              clientRes.write(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn' },
                  usage: { output_tokens: estOutTokens }
                })}\n\n`
              );
              clientRes.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            }
            clientRes.end();

            resolve({
              ok: true,
              streamed: true,
              status: 200,
              ttftMs,
              totalMs,
              estOutTokens
            });
          });
          return;
        }

        // Non-streaming 2xx response
        const chunks = [];
        upRes.on('data', (c) => {
          if (!ttftMs) ttftMs = Date.now() - t0;
          chunks.push(c);
        });
        upRes.on('end', () => {
          const totalMs = Math.max(1, Date.now() - t0);
          const body = Buffer.concat(chunks);
          let estOutTokens = Math.max(1, Math.ceil(body.length / 16));
          try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed.usage && parsed.usage.completion_tokens) {
              estOutTokens = parsed.usage.completion_tokens;
            } else if (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) {
              estOutTokens = Math.max(1, Math.ceil(parsed.choices[0].message.content.length / 4));
            }
          } catch (_) {}

          resolve({
            ok: true,
            streamed: false,
            status,
            headers: upRes.headers,
            body,
            ttftMs: ttftMs || totalMs,
            totalMs,
            estOutTokens
          });
        });
      }
    );

    req.on('error', (err) => {
      resolve({ ok: false, status: 503, ttftMs: Date.now() - t0, totalMs: Date.now() - t0, errorText: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 504, ttftMs: Date.now() - t0, totalMs: Date.now() - t0, errorText: 'Upstream timeout' });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Parallel Live Provider Speed Benchmark (tok/s) & Key Health Tester
 */
async function benchmarkSingleCandidate(cand) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let targetUrl;
    try {
      targetUrl = new URL(cand.baseURL.replace(/\/+$/, '') + '/chat/completions');
    } catch (e) {
      resolve({ providerId: cand.providerId, model: cand.fullRef, status: 'invalid-url', ok: false, error: e.message });
      return;
    }

    const payload = JSON.stringify({
      model: cand.modelId,
      messages: [{ role: 'user', content: 'Write a 1-line JavaScript arrow function add(a,b) and nothing else.' }],
      max_tokens: 36,
      temperature: 0,
      stream: true
    });

    const isHttps = targetUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = buildProviderHeaders(cand, Buffer.byteLength(payload));

    let ttftMs = 0;
    let outChars = 0;

    const req = lib.request(
      targetUrl,
      {
        method: 'POST',
        headers,
        timeout: cand.localNoKey ? 2200 : 12000
      },
      (res) => {
        const code = res.statusCode || 500;
        if (code < 200 || code >= 300) {
          let errTxt = '';
          res.on('data', (c) => (errTxt += c.toString()));
          res.on('end', () => {
            const label = code === 401 || code === 403 ? 'invalid-key' : code === 429 || code === 402 ? 'quota-429' : `http-${code}`;
            resolve({
              providerId: cand.providerId,
              providerName: cand.providerName,
              model: cand.fullRef,
              ok: false,
              httpStatus: code,
              status: label,
              ttftMs: Date.now() - t0,
              totalMs: Date.now() - t0,
              tokPerSec: 0,
              error: errTxt.slice(0, 140)
            });
          });
          return;
        }

        let buf = '';
        res.on('data', (c) => {
          if (!ttftMs) ttftMs = Date.now() - t0;
          const s = c.toString('utf8');
          buf += s;
          const matches = s.match(/"content"\s*:\s*"([^"]*)"/g);
          if (matches) {
            for (const m of matches) outChars += Math.max(1, m.length - 12);
          }
        });
        res.on('end', () => {
          const totalMs = Math.max(1, Date.now() - t0);
          if (!ttftMs) ttftMs = totalMs;
          if (outChars === 0 && buf.length > 20) {
            outChars = Math.min(120, Math.ceil(buf.length / 8));
          }
          const outTokens = Math.max(4, Math.ceil(outChars / 3.8));
          const genWindowMs = Math.max(40, totalMs - Math.min(ttftMs * 0.6, totalMs - 40));
          const tokPerSec = Math.round((outTokens / (genWindowMs / 1000)) * 10) / 10;

          resolve({
            providerId: cand.providerId,
            providerName: cand.providerName,
            model: cand.fullRef,
            ok: true,
            httpStatus: 200,
            status: 'healthy',
            ttftMs,
            totalMs,
            outTokens,
            tokPerSec
          });
        });
      }
    );

    req.on('error', (err) => {
      resolve({
        providerId: cand.providerId,
        providerName: cand.providerName,
        model: cand.fullRef,
        ok: false,
        httpStatus: 0,
        status: cand.localNoKey ? 'offline-local' : 'unreachable',
        ttftMs: 0,
        totalMs: Date.now() - t0,
        tokPerSec: 0,
        error: err.message
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        providerId: cand.providerId,
        providerName: cand.providerName,
        model: cand.fullRef,
        ok: false,
        httpStatus: 504,
        status: 'timeout',
        ttftMs: 0,
        totalMs: Date.now() - t0,
        tokPerSec: 0,
        error: 'Timed out'
      });
    });

    req.write(payload);
    req.end();
  });
}

async function runParallelBenchmark(candidates = []) {
  const results = await Promise.all(candidates.map((c) => benchmarkSingleCandidate(c)));
  results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return b.tokPerSec - a.tokPerSec;
  });
  return results;
}

function hashPromptCacheKey(modelHint, messages, tools) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ m: modelHint || 'auto', messages: messages || [], tools: tools || null }))
    .digest('hex');
}

module.exports = {
  translateAnthropicRequestToOpenAI,
  translateOpenAIResponseToAnthropic,
  sendCachedAsSse,
  executeUpstreamCandidate,
  benchmarkSingleCandidate,
  runParallelBenchmark,
  hashPromptCacheKey
};
