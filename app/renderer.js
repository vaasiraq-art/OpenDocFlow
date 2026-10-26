'use strict';

(() => {
  const api = window.studioAPI;
  const $ = (id) => document.getElementById(id);

  // ==================== APPLICATION STATE ====================
  const state = {
    activeTab: 'agent-studio',
    loadedTabs: new Set(['agent-studio']),
    system: null,
    settings: { portableRoot: '', usePortablePrefix: false, safeGpuMode: false },
    telemetry: null,
    agentsHub: null,
    providersData: null,
    chatHistory: [],
    activeSessionId: null,
    activePersona: 'opendocflow',
    docflowSessionId: null,
    lastPackedRepo: null,
    editingItem: null,
    installBadges: {},
    nodeGraph: null
  };

  // ==================== SAFE HTML & MARKDOWN HELPERS ====================
  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderLightMarkdown(raw) {
    if (!raw) return '';
    const escaped = escHtml(raw);
    // Render fenced code blocks ```lang ... ```
    const withBlocks = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const lbl = lang ? `<div style="font-size:10.5px;color:#8b9bb4;margin-bottom:4px;">${lang}</div>` : '';
      return `<pre>${lbl}<code>${code}</code></pre>`;
    });
    // Inline `code` and **bold**
    return withBlocks
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }

  function toast(msg, isError = false) {
    const wrap = $('toastContainer');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3600);
  }

  function appendConsole(text) {
    const pre = $('dock-console');
    if (!pre) return;
    pre.textContent += text;
    if (pre.textContent.length > 48000) {
      pre.textContent = pre.textContent.slice(-36000);
    }
    const body = $('dockBody');
    if (body) body.scrollTop = body.scrollHeight;
  }

  // ==================== NAVIGATION & LAZY HYDRATION ====================
  async function switchTab(tabId) {
    state.activeTab = tabId;
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.view-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.id === `tab-${tabId}`);
    });

    if (!state.loadedTabs.has(tabId)) {
      state.loadedTabs.add(tabId);
      await hydrateTab(tabId);
    }
    if (tabId === 'gateway') {
      requestAnimationFrame(drawGraphEdges);
    }
  }

  async function hydrateTab(tabId) {
    try {
      if (tabId === 'agents-hub') await loadAgentsHubView();
      else if (tabId === 'gateway') await loadGatewayView();
      else if (tabId === 'providers') await loadProvidersView();
      else if (tabId === 'free-models') await loadFreeModelsView(false);
      else if (tabId === 'mcp') await loadMcpView();
      else if (tabId === 'skills') renderSkillsAndPlugins();
      else if (tabId === 'installer') renderTurboInstaller();
      else if (tabId === 'cloud') await loadCloudAndProfilesView();
      else if (tabId === 'bugs') await loadBugsView();
    } catch (e) {
      toast(`Failed loading ${tabId}: ${e.message}`, true);
    }
  }

  // ==================== HEADER & SYSTEM STATUS ====================
  function applySystemStatusToUI(sys) {
    if (!sys) return;
    state.system = sys;
    $('appVersionBadge').textContent = `v${sys.appVersion || '4.0.0'}`;
    $('activeModelLabel').textContent = sys.currentModel || 'studio-gateway/auto-coding';
    $('quickModelInput').value = sys.currentModel || 'studio-gateway/auto-coding';
    $('navMcpCount').textContent = String((sys.mcpServers || []).length);
    $('navSkillsCount').textContent = String((sys.skills || []).length);

    if (state.loadedTabs.has('skills')) renderSkillsAndPlugins();
    if (state.loadedTabs.has('installer')) renderTurboInstaller();
  }

  function applyTelemetryToUI(tel) {
    if (!tel) return;
    state.telemetry = tel;
    const toks = tel.lastTokPerSec || 0;
    $('headerToksBadge').textContent = `${toks} tok/s`;
    $('gatewayHeaderText').textContent = tel.running ? ':4141 Online' : ':4141 Offline';

    $('gwKpiToks').textContent = `${toks} tok/s`;
    $('gwKpiLatency').textContent = `Avg TTFT: ${tel.avgLatencyMs || 0} ms`;
    $('gwKpiReqs').textContent = String(tel.requestsTotal || 0);
    $('gwKpiCache').textContent = `0ms Cache Hits: ${tel.cacheHits || 0}`;
    $('gwKpiFailovers').textContent = String(tel.failoversSaved || 0);
    $('gwKpiTokensSaved').textContent = `Tokens Saved: ${(tel.tokensSaved || 0).toLocaleString()}`;

    $('gwStrategySelect').value = tel.strategy || 'smart-coding';
    $('chkGwCompression').checked = tel.compressionEnabled !== false;
    $('chkGwCache').checked = tel.promptCacheEnabled !== false;
    $('chkGwAutoBug').checked = tel.autoBugReport !== false;

    // Inspector Drawer
    $('inspLastModel').textContent = tel.lastGoodModel || '—';
    $('inspToks').textContent = `${toks} tok/s`;
    $('inspLatency').textContent = `${tel.avgLatencyMs || 0} ms`;

    const speedsWrap = $('inspProviderSpeeds');
    const speedEntries = Object.entries(tel.providerSpeeds || {}).sort((a, b) => b[1] - a[1]);
    if (speedEntries.length === 0) {
      speedsWrap.innerHTML = '<div class="muted">No provider speed samples yet.</div>';
    } else {
      speedsWrap.innerHTML = speedEntries
        .map(
          ([pid, spd]) =>
            `<div class="stack-row"><span>${escHtml(pid)}</span><strong class="accent-text">${escHtml(spd)} tok/s</strong></div>`
        )
        .join('');
    }

    renderDockRequests(tel.recentRequests || []);
    renderDockEvents(tel.recentEvents || []);
  }

  function renderDockRequests(reqs) {
    $('dockReqCount').textContent = String(reqs.length);
    const tbody = $('liveRequestsTbody');
    if (!tbody) return;
    if (!reqs.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Waiting for live requests on http://127.0.0.1:4141/v1…</td></tr>';
      return;
    }
    tbody.innerHTML = reqs
      .slice(0, 30)
      .map((r) => {
        const t = (r.ts || '').slice(11, 19);
        return `<tr>
          <td><code>${escHtml(t)}</code></td>
          <td>${escHtml(r.wire || 'OpenAI')}</td>
          <td><code>${escHtml(r.requestedModel || '')}</code></td>
          <td><code>${escHtml(r.routedModel || '')}</code></td>
          <td>${escHtml(r.ttftMs ?? 0)} ms</td>
          <td><strong class="accent-text">${escHtml(r.tokPerSec ?? 0)} tok/s</strong></td>
          <td><span class="badge-ok">${r.cached ? 'CACHE 200' : escHtml(r.status || 200)}</span></td>
        </tr>`;
      })
      .join('');
  }

  function renderDockEvents(events) {
    const pane = $('dock-events');
    if (!pane) return;
    pane.innerHTML = events
      .slice(0, 30)
      .map(
        (e) =>
          `<div style="font-family:var(--font-mono);font-size:11.5px;padding:2px 0;border-bottom:1px solid #161e2e;">
            <span style="color:#6d82a3;">[${escHtml((e.ts || '').slice(11, 19))}]</span>
            <strong style="color:#4f8cff;"> ${escHtml(e.type)}:</strong>
            <span> ${escHtml(e.detail)}</span>
          </div>`
      )
      .join('');
  }

  // ==================== 1. LIVE AGENT STUDIO ====================
  function setupAgentStudio() {
    $('agentEngineSelect').addEventListener('change', () => {
      const eng = $('agentEngineSelect').value;
      $('agentCliPickerWrap').style.display = eng === 'cli' ? 'flex' : 'none';
      $('arenaModelBWrap').style.display = eng === 'arena' ? 'flex' : 'none';
    });

    document.querySelectorAll('.persona-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.persona-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        state.activePersona = pill.dataset.persona;
      });
    });

    $('btnAgentPickDir').addEventListener('click', async () => {
      const dir = await api.pickDirectory();
      if (dir) {
        $('agentWorkspaceInput').value = dir;
        if (!$('docflowDirInput').value) $('docflowDirInput').value = dir;
      }
    });

    $('btnAgentClearChat').addEventListener('click', () => {
      state.chatHistory = [];
      $('agentChatFeed').innerHTML = '';
      toast('Cleared Agent Studio session');
    });

    document.querySelectorAll('.starter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (chip.dataset.arena === 'true') {
          $('agentEngineSelect').value = 'arena';
          $('agentEngineSelect').dispatchEvent(new Event('change'));
        }
        $('agentPromptInput').value = chip.dataset.prompt || '';
        sendAgentTurn();
      });
    });

    $('btnAgentSend').addEventListener('click', sendAgentTurn);
    $('btnAgentStop').addEventListener('click', async () => {
      await api.stopAgentStudioTurn();
      setAgentBusy(false);
    });

    $('agentPromptInput').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendAgentTurn();
      }
    });
  }

  function setAgentBusy(busy, statusText = 'Streaming…') {
    $('btnAgentSend').classList.toggle('hidden', busy);
    $('btnAgentStop').classList.toggle('hidden', !busy);
    $('agentLiveStatusStrip').classList.toggle('hidden', !busy);
    $('agentLiveStatusText').textContent = statusText;
  }

  let currentMsgRefs = null;

  async function sendAgentTurn() {
    const prompt = $('agentPromptInput').value.trim();
    if (!prompt) return;
    $('agentPromptInput').value = '';

    const empty = $('agentEmptyState');
    if (empty) empty.remove();

    const feed = $('agentChatFeed');
    const engine = $('agentEngineSelect').value;
    const cliId = $('agentCliSelect').value;
    const model = $('agentModelInput').value.trim() || 'auto-coding';
    const arenaModelB = $('agentArenaModelB').value.trim() || 'openrouter/qwen/qwen3-coder:free';
    const workspaceDir = $('agentWorkspaceInput').value.trim();
    const enableTools = $('chkAgentTools').checked;
    const allowWrite = $('chkAgentWrite').checked;

    // Append User Bubble
    const userEl = document.createElement('div');
    userEl.className = 'chat-msg user';
    userEl.innerHTML = `<div class="msg-meta"><strong>You</strong><span>@${escHtml(state.activePersona)}</span></div><div class="msg-body">${escHtml(prompt)}</div>`;
    feed.appendChild(userEl);

    // Append Live Assistant Bubble
    const sessionId = `chat_${Date.now()}`;
    state.activeSessionId = sessionId;

    const botEl = document.createElement('div');
    botEl.className = 'chat-msg assistant';

    if (engine === 'arena') {
      botEl.innerHTML = `
        <div class="msg-meta"><strong>⚔ Dual-Model Arena</strong><span id="${sessionId}_meta">Racing live…</span></div>
        <div class="arena-split">
          <div class="arena-col">
            <div class="arena-col-head"><span>Model A: ${escHtml(model)}</span><span id="${sessionId}_spdA">…</span></div>
            <div class="msg-body" id="${sessionId}_bodyA"></div>
          </div>
          <div class="arena-col">
            <div class="arena-col-head"><span>Model B: ${escHtml(arenaModelB)}</span><span id="${sessionId}_spdB">…</span></div>
            <div class="msg-body" id="${sessionId}_bodyB"></div>
          </div>
        </div>`;
      currentMsgRefs = { sessionId, arena: true, rawA: '', rawB: '' };
    } else {
      botEl.innerHTML = `
        <div class="msg-meta">
          <strong>⚡ @${escHtml(state.activePersona)} (${escHtml(engine)})</strong>
          <span id="${sessionId}_meta">${escHtml(model)}</span>
        </div>
        <div id="${sessionId}_tools"></div>
        <div class="msg-body" id="${sessionId}_body"></div>`;
      currentMsgRefs = { sessionId, arena: false, rawMain: '' };
    }

    feed.appendChild(botEl);
    feed.scrollTop = feed.scrollHeight;
    setAgentBusy(true, 'Connecting to :4141 Smart Gateway…');

    const priorHistory = state.chatHistory.slice(-10);
    state.chatHistory.push({ role: 'user', content: prompt });

    await api.runAgentStudioTurn({
      engine,
      cliId,
      persona: state.activePersona,
      model,
      arenaModelB,
      prompt,
      history: priorHistory,
      workspaceDir,
      enableTools,
      allowWrite,
      sessionId
    });
  }

  function handleAgentStreamChunk(chunk) {
    if (!chunk || !chunk.sessionId) return;

    // Route DocFlow AI Docs Generator live chunks directly to DocFlow editor!
    if (chunk.sessionId === state.docflowSessionId) {
      if (chunk.type === 'delta' && chunk.text) {
        const ed = $('docflowGeneratedEditor');
        ed.value += chunk.text;
        ed.scrollTop = ed.scrollHeight;
        $('docflowGenStatus').textContent = `${chunk.tokPerSec || '…'} tok/s`;
      } else if (chunk.type === 'done') {
        $('docflowGenStatus').textContent = `Done (${chunk.tokPerSec || 'OK'} tok/s)`;
        toast('AI documentation finished streaming!');
      } else if (chunk.type === 'error') {
        $('docflowGenStatus').textContent = 'Error';
        toast(`DocFlow error: ${chunk.text}`, true);
      }
      return;
    }

    // Route Agent Studio chat chunks
    if (!currentMsgRefs || chunk.sessionId !== currentMsgRefs.sessionId) return;
    const feed = $('agentChatFeed');

    if (chunk.type === 'status') {
      $('agentLiveStatusText').textContent = chunk.text;
      return;
    }

    if (chunk.type === 'tool') {
      const toolsWrap = $(`${chunk.sessionId}_tools`);
      if (toolsWrap) {
        const pill = document.createElement('div');
        pill.className = 'tool-call-pill';
        const argPreview = JSON.stringify(chunk.toolArgs || {}).slice(0, 110);
        pill.textContent =
          chunk.status === 'running'
            ? `🛠 Running ${chunk.toolName}(${argPreview})…`
            : `✓ ${chunk.toolName}(${argPreview})`;
        toolsWrap.appendChild(pill);
      }
      return;
    }

    if (chunk.type === 'delta') {
      if (currentMsgRefs.arena) {
        if (chunk.slot === 'A') {
          currentMsgRefs.rawA += chunk.text;
          const bA = $(`${chunk.sessionId}_bodyA`);
          if (bA) bA.innerHTML = renderLightMarkdown(currentMsgRefs.rawA);
          const sA = $(`${chunk.sessionId}_spdA`);
          if (sA && chunk.tokPerSec) sA.textContent = `${chunk.tokPerSec} tok/s`;
        } else if (chunk.slot === 'B') {
          currentMsgRefs.rawB += chunk.text;
          const bB = $(`${chunk.sessionId}_bodyB`);
          if (bB) bB.innerHTML = renderLightMarkdown(currentMsgRefs.rawB);
          const sB = $(`${chunk.sessionId}_spdB`);
          if (sB && chunk.tokPerSec) sB.textContent = `${chunk.tokPerSec} tok/s`;
        }
      } else {
        currentMsgRefs.rawMain += chunk.text;
        const bodyEl = $(`${chunk.sessionId}_body`);
        if (bodyEl) bodyEl.innerHTML = renderLightMarkdown(currentMsgRefs.rawMain);
        const metaEl = $(`${chunk.sessionId}_meta`);
        if (metaEl && chunk.model) {
          metaEl.textContent = `${chunk.model}${chunk.tokPerSec ? ` • ${chunk.tokPerSec} tok/s` : ''}`;
        }
      }
      feed.scrollTop = feed.scrollHeight;
      return;
    }

    if (chunk.type === 'error') {
      setAgentBusy(false);
      const bodyEl = $(`${chunk.sessionId}_body`);
      if (bodyEl) {
        bodyEl.innerHTML += `<div class="muted-box mt-8" style="border-color:var(--danger);color:#ff9b9b;">⚠ ${escHtml(chunk.text)}</div>`;
      }
      return;
    }

    if (chunk.type === 'done') {
      setAgentBusy(false);
      if (!currentMsgRefs.arena) {
        const finalTxt = currentMsgRefs.rawMain || chunk.text || '';
        const bodyEl = $(`${chunk.sessionId}_body`);
        if (bodyEl) bodyEl.innerHTML = renderLightMarkdown(finalTxt);
        const metaEl = $(`${chunk.sessionId}_meta`);
        if (metaEl && chunk.model) {
          metaEl.textContent = `${chunk.model}${chunk.ttftMs ? ` • TTFT ${chunk.ttftMs}ms` : ''}${chunk.tokPerSec ? ` • ${chunk.tokPerSec} tok/s` : ''}`;
        }
        if (finalTxt) state.chatHistory.push({ role: 'assistant', content: finalTxt });
      } else {
        const metaEl = $(`${chunk.sessionId}_meta`);
        if (metaEl) metaEl.textContent = 'Arena Complete ✓';
      }
    }
  }

  // ==================== 2. MULTI-AGENT HUB ====================
  async function loadAgentsHubView() {
    const hub = await api.getAgentsHub();
    state.agentsHub = hub;
    renderAgentsHub(hub);
  }

  function renderAgentsHub(hub) {
    if (!hub || !Array.isArray(hub.agents)) return;
    const installedCount = hub.agents.filter((a) => a.installed).length;
    $('navAgentsCount').textContent = `${installedCount}/${hub.agents.length}`;

    const grid = $('agentsHubGrid');
    grid.innerHTML = hub.agents
      .map((a) => {
        const prog = state.installBadges[a.id];
        const badgeHtml = prog
          ? `<span class="badge-ok">${escHtml(prog)}</span>`
          : a.installed
            ? `<span class="badge-ok">✓ Ready</span>`
            : `<span class="badge-miss">Not Installed</span>`;

        const installBtn = !a.builtin
          ? `<button class="btn btn-secondary btn-xs hub-install-btn" data-id="${escHtml(a.id)}">${a.installed ? '↻ Update' : '⬇ 1-Click Install'}</button>`
          : '';
        const launchBtn = a.builtin
          ? `<button class="btn btn-primary btn-xs hub-open-studio-btn">Open Agent Studio</button>`
          : `<button class="btn btn-primary btn-xs hub-launch-btn" data-cmd="${escHtml(a.launchCmd)}" ${!a.installed ? 'disabled' : ''}>▶ Launch CLI</button>`;

        return `<div class="item-card ${a.installed ? 'installed' : ''}">
          <div>
            <div class="item-head">
              <strong>${escHtml(a.name)}</strong>
              ${badgeHtml}
            </div>
            <div class="muted mt-6">${escHtml(a.description)}</div>
            <div class="muted-label mt-6"><code>${escHtml(a.binaryPath || a.category)}</code></div>
          </div>
          <div class="btn-row mt-8">
            ${launchBtn}
            ${installBtn}
          </div>
        </div>`;
      })
      .join('');

    grid.querySelectorAll('.hub-install-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        toast(`Installing ${id} via Turbo Installer…`);
        await api.installPrerequisites([id], {});
        await loadAgentsHubView();
        applySystemStatusToUI(await api.getSystemStatus(true));
      });
    });

    grid.querySelectorAll('.hub-launch-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cwd = $('agentWorkspaceInput').value.trim() || '';
        await api.launchCliAgentExternal({ cmd: btn.dataset.cmd, cwd });
        toast(`Launched ${btn.dataset.cmd} wired to :4141/v1`);
      });
    });

    grid.querySelectorAll('.hub-open-studio-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab('agent-studio'));
    });

    // Specialist Team List
    const teamWrap = $('specialistTeamList');
    teamWrap.innerHTML = (hub.specialistTeam || [])
      .map(
        (sp) => `<div class="stack-row">
          <div>
            <strong>@${escHtml(sp.id)}</strong> <span class="muted-label">(${escHtml(sp.role)})</span>
            <div class="muted">${escHtml(sp.description)}</div>
          </div>
          <button class="btn btn-secondary btn-xs use-persona-btn" data-persona="${escHtml(sp.id)}">Use</button>
        </div>`
      )
      .join('');

    teamWrap.querySelectorAll('.use-persona-btn').forEach((b) => {
      b.addEventListener('click', () => {
        state.activePersona = b.dataset.persona;
        document.querySelectorAll('.persona-pill').forEach((p) => {
          p.classList.toggle('active', p.dataset.persona === state.activePersona);
        });
        switchTab('agent-studio');
      });
    });

    // Slash commands
    $('slashCommandsShowcase').innerHTML = (hub.slashCommands || [])
      .map(
        (c) => `<div class="stack-row">
          <div><code>/${escHtml(c.id)}</code><div class="muted">${escHtml(c.description)}</div></div>
        </div>`
      )
      .join('');
  }

  // ==================== 3. DOCFLOW STUDIO ====================
  function setupDocFlowStudio() {
    $('btnDocflowBrowse').addEventListener('click', async () => {
      const dir = await api.pickDirectory();
      if (dir) $('docflowDirInput').value = dir;
    });

    $('btnDocflowPack').addEventListener('click', async () => {
      const dirPath = $('docflowDirInput').value.trim() || $('agentWorkspaceInput').value.trim();
      if (!dirPath) {
        toast('Select a repository folder first', true);
        return;
      }
      $('btnDocflowPack').disabled = true;
      $('btnDocflowPack').textContent = 'Packing…';
      const res = await api.packRepository({ dirPath, maxFiles: 180 });
      $('btnDocflowPack').disabled = false;
      $('btnDocflowPack').textContent = '📦 Pack Repo to LLM Markdown';

      if (!res || !res.ok) {
        toast((res && res.error) || 'Failed to pack folder', true);
        return;
      }
      state.lastPackedRepo = res;
      $('dfStatFiles').textContent = res.filesPacked.toLocaleString();
      $('dfStatLines').textContent = res.totalLines.toLocaleString();
      $('dfStatTokens').textContent = res.estTokens.toLocaleString();
      $('docflowPackedPreview').value = res.markdown;

      $('btnDocflowCopyPack').disabled = false;
      $('btnDocflowSavePack').disabled = false;
      $('btnDocflowSendToAgent').disabled = false;

      $('docflowTopFiles').innerHTML = (res.topFiles || [])
        .slice(0, 6)
        .map((f) => `<span style="margin-right:10px;"><code>${escHtml(f.path)}</code> (${f.tokens.toLocaleString()} tok)</span>`)
        .join(' ');
      toast(`Packed ${res.filesPacked} files (~${res.estTokens.toLocaleString()} tokens, secrets redacted)`);
    });

    $('btnDocflowCopyPack').addEventListener('click', async () => {
      if (!state.lastPackedRepo) return;
      await api.copyTextClipboard(state.lastPackedRepo.markdown);
      toast('Copied full LLM repository context to clipboard!');
    });

    $('btnDocflowSavePack').addEventListener('click', async () => {
      const dirPath = $('docflowDirInput').value.trim();
      if (!dirPath) return;
      const res = await api.packRepository({ dirPath, saveToFile: true });
      if (res && res.savedFile) toast(`Saved ${res.savedFile}`);
    });

    $('btnDocflowSendToAgent').addEventListener('click', () => {
      if (!state.lastPackedRepo) return;
      $('agentWorkspaceInput').value = state.lastPackedRepo.rootDir;
      $('agentPromptInput').value = `Here is a packed overview of "${state.lastPackedRepo.repoName}". Analyze the architecture, key modules, and top improvements:\n\n${state.lastPackedRepo.markdown.slice(0, 28000)}`;
      switchTab('agent-studio');
    });

    document.querySelectorAll('.docflow-gen-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const dirPath = $('docflowDirInput').value.trim() || $('agentWorkspaceInput').value.trim();
        if (!dirPath) {
          toast('Select a repository folder first', true);
          return;
        }
        const docType = btn.dataset.doctype;
        $('docflowTargetFilename').value = btn.dataset.filename;
        $('docflowGeneratedEditor').value = '';
        const sessionId = `docflow_${Date.now()}`;
        state.docflowSessionId = sessionId;
        $('docflowGenStatus').textContent = `Packing & Streaming ${btn.dataset.filename}…`;
        await api.generateAiDocs({ dirPath, docType, sessionId });
      });
    });

    $('btnDocflowCopyGenerated').addEventListener('click', async () => {
      await api.copyTextClipboard($('docflowGeneratedEditor').value);
      toast('Copied generated Markdown!');
    });

    $('btnDocflowSaveToRepo').addEventListener('click', async () => {
      const dirPath = $('docflowDirInput').value.trim();
      const fileName = $('docflowTargetFilename').value.trim() || 'README.md';
      const content = $('docflowGeneratedEditor').value;
      if (!dirPath || !content.trim()) {
        toast('Select a repo folder and generate content first', true);
        return;
      }
      const res = await api.saveGeneratedDocFile({ dirPath, fileName, content });
      if (res && res.ok) toast(`Saved to ${res.fullPath}`);
    });
  }

  // ==================== 4. GATEWAY, NODE GRAPH & BENCHMARK ====================
  const DEFAULT_GRAPH_NODES = [
    { id: 'ides', title: 'All Coding Agents', sub: 'OpenCode • Claude • Codex • Cursor', x: 24, y: 78 },
    { id: 'gateway', title: 'OpenDocFlow :4141', sub: 'True SSE + Anthropic/OpenAI', x: 255, y: 78, core: true },
    { id: 'pool', title: 'Multi-Key Pool + Cache', sub: '0ms SHA-256 + Key Rotation', x: 495, y: 30 },
    { id: 'failover', title: 'Self-Healing Router', sub: '429 Lockout + Fastest tok/s', x: 495, y: 128 },
    { id: 'upstreams', title: '20+ Cloud & Local LLMs', sub: 'Gemini • Qwen3 • Groq • Ollama', x: 735, y: 78 }
  ];
  const GRAPH_EDGES = [
    ['ides', 'gateway'],
    ['gateway', 'pool'],
    ['gateway', 'failover'],
    ['pool', 'upstreams'],
    ['failover', 'upstreams']
  ];

  async function loadGatewayView() {
    const saved = await api.getNodeGraphLayout();
    state.nodeGraph = Array.isArray(saved) && saved.length === DEFAULT_GRAPH_NODES.length ? saved : JSON.parse(JSON.stringify(DEFAULT_GRAPH_NODES));
    renderGraphNodes();
  }

  function renderGraphNodes() {
    const layer = $('nodeGraphLayer');
    if (!layer || !state.nodeGraph) return;
    layer.innerHTML = '';

    state.nodeGraph.forEach((n) => {
      const el = document.createElement('div');
      el.className = `graph-node${n.core ? ' gateway-core' : ''}`;
      el.dataset.id = n.id;
      el.style.left = `${n.x}px`;
      el.style.top = `${n.y}px`;
      el.innerHTML = `<div class="graph-node-title">${escHtml(n.title)}</div><div class="graph-node-sub">${escHtml(n.sub)}</div>`;

      let dragging = false;
      let startX = 0;
      let startY = 0;
      el.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX - n.x;
        startY = e.clientY - n.y;
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        n.x = Math.max(8, Math.min(820, e.clientX - startX));
        n.y = Math.max(8, Math.min(175, e.clientY - startY));
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        drawGraphEdges();
      });
      window.addEventListener('mouseup', () => {
        if (dragging) {
          dragging = false;
          api.saveNodeGraphLayout(state.nodeGraph);
        }
      });

      layer.appendChild(el);
    });
    requestAnimationFrame(drawGraphEdges);
  }

  function drawGraphEdges() {
    const svg = $('nodeGraphSvg');
    if (!svg || !state.nodeGraph) return;
    const byId = Object.fromEntries(state.nodeGraph.map((n) => [n.id, n]));
    svg.innerHTML = GRAPH_EDGES.map(([a, b]) => {
      const n1 = byId[a];
      const n2 = byId[b];
      if (!n1 || !n2) return '';
      const x1 = n1.x + 165;
      const y1 = n1.y + 26;
      const x2 = n2.x;
      const y2 = n2.y + 26;
      const cx = (x1 + x2) / 2;
      return `<path d="M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}" stroke="#2dd4bf" stroke-width="2" fill="none" stroke-opacity="0.65" />`;
    }).join('');
  }

  async function executeBenchmark(autoSortChain) {
    const wrap = $('benchmarkResultsWrap');
    wrap.innerHTML = '<div class="muted-box">⚡ Benchmarking all configured providers in parallel…</div>';
    const res = await api.runProviderBenchmark({ autoSortChain });
    const list = (res && res.results) || [];
    if (list.length === 0) {
      wrap.innerHTML = '<div class="muted-box">No configured provider keys or local Ollama detected yet. Add a key in <strong>AI Keys &amp; Scanner</strong> first.</div>';
      return;
    }
    const maxSpd = Math.max(40, ...list.map((r) => r.tokPerSec || 0));
    wrap.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Provider</th><th>Model Tested</th><th>Status</th><th>TTFT</th><th>Live Speed (tok/s)</th></tr></thead>
      <tbody>
        ${list
          .map((r) => {
            const pct = Math.min(100, Math.round(((r.tokPerSec || 0) / maxSpd) * 100));
            return `<tr>
              <td><strong>${escHtml(r.providerName || r.providerId)}</strong></td>
              <td><code>${escHtml(r.model)}</code></td>
              <td>${r.ok ? '<span class="badge-ok">✓ Healthy</span>' : `<span class="badge-miss">HTTP ${escHtml(r.status || 'ERR')}</span>`}</td>
              <td>${r.ok ? `${escHtml(r.ttftMs)} ms` : '—'}</td>
              <td>${
                r.ok
                  ? `<span class="speed-bar-wrap"><span class="speed-bar-fill" style="width:${pct}%"></span></span><strong>${escHtml(r.tokPerSec)} tok/s</strong>`
                  : `<span class="muted">${escHtml(r.error || '')}</span>`
              }</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table></div>`;
    applyTelemetryToUI(await api.getGatewayTelemetry());
    if (autoSortChain) toast('Sorted Free Combo Chain by fastest healthy models!');
  }

  // ==================== 5. AI KEYS & MULTI-KEY POOL ====================
  async function loadProvidersView() {
    const data = await api.getProvidersState();
    if (!data) return;
    state.providersData = data;
    const configuredCount = (data.providers || []).filter((p) => p.hasKey).length;
    $('navKeysCount').textContent = String(configuredCount);

    const sel = $('scanProviderSelect');
    sel.innerHTML = (data.providers || [])
      .map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.name)}</option>`)
      .join('');

    renderProviderCards();
  }

  function renderProviderCards() {
    if (!state.providersData) return;
    const q = ($('providerSearchInput').value || '').trim().toLowerCase();
    const onlyCfg = $('chkFilterConfigured').checked;

    const list = (state.providersData.providers || []).filter((p) => {
      if (onlyCfg && !p.hasKey) return false;
      if (q && !`${p.name} ${p.id} ${p.badge}`.toLowerCase().includes(q)) return false;
      return true;
    });

    const grid = $('providersCardsGrid');
    grid.innerHTML = list
      .map((p) => {
        const keyBadge = p.hasKey
          ? `<span class="badge-ok">✓ ${p.keyCount} Key${p.keyCount > 1 ? 's' : ''} Pooled${p.tokPerSec ? ` • ${p.tokPerSec} tok/s` : ''}</span>`
          : `<span class="badge-miss">${escHtml(p.badge || p.tier)}</span>`;

        return `<div class="item-card ${p.hasKey ? 'installed' : ''}" data-pid="${escHtml(p.id)}">
          <div>
            <div class="item-head">
              <strong>${escHtml(p.name)}</strong>
              ${keyBadge}
            </div>
            <textarea class="code-textarea masked-textarea mt-8 p-key-area" rows="2" placeholder="${
              p.localNoKey
                ? 'Local server (no API key required)'
                : p.hasKey
                  ? 'Saved in vault — paste 1 key per line to replace/pool keys…'
                  : 'Paste API key (or multiple keys, 1 per line for rotation)…'
            }"></textarea>
            <input type="text" class="full-width mt-6 input-sm p-url-input" value="${escHtml(p.baseURL || '')}" placeholder="Base URL (/v1)" />
          </div>
          <div class="btn-row mt-8">
            <button class="btn btn-primary btn-xs p-save-btn">💾 Save Pool</button>
            <button class="btn btn-secondary btn-xs p-test-btn">⚡ Test Speed</button>
            <button class="btn btn-secondary btn-xs p-scan-btn">🔍 Scan</button>
            <button class="btn btn-ghost btn-xs p-mask-btn" title="Show / Mask Keys">👁</button>
            ${p.keyUrl ? `<button class="btn btn-ghost btn-xs p-getkey-btn" data-url="${escHtml(p.keyUrl)}">Get Key ↗</button>` : ''}
            ${p.hasKey ? `<button class="btn btn-danger btn-xs p-del-btn">Clear</button>` : ''}
          </div>
        </div>`;
      })
      .join('');

    grid.querySelectorAll('.item-card').forEach((card) => {
      const pid = card.dataset.pid;
      const keyArea = card.querySelector('.p-key-area');
      const urlInp = card.querySelector('.p-url-input');

      card.querySelector('.p-mask-btn').addEventListener('click', () => {
        keyArea.classList.toggle('masked-textarea');
      });

      card.querySelector('.p-save-btn').addEventListener('click', async () => {
        const res = await api.saveProviderKey({
          id: pid,
          apiKey: keyArea.value,
          baseURL: urlInp.value
        });
        if (res && res.ok) {
          toast(`Saved key pool for ${pid}`);
          await loadProvidersView();
        }
      });

      card.querySelector('.p-test-btn').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.textContent = 'Testing…';
        const res = await api.testSingleProviderKey({
          id: pid,
          apiKey: keyArea.value,
          baseURL: urlInp.value
        });
        btn.textContent = '⚡ Test Speed';
        if (res && res.ok) {
          toast(`${pid}: ${res.tokPerSec} tok/s (TTFT ${res.ttftMs}ms)`);
          await loadProvidersView();
        } else {
          toast(`${pid} failed: ${(res && res.error) || 'Unreachable'}`, true);
        }
      });

      card.querySelector('.p-scan-btn').addEventListener('click', async () => {
        toast(`Scanning ${pid} /models…`);
        const res = await api.discoverModelsFromKey({
          id: pid,
          apiKey: keyArea.value,
          baseURL: urlInp.value
        });
        if (res && res.ok) {
          toast(`Discovered & wired ${res.count} models from ${pid}`);
          await loadProvidersView();
        } else {
          toast((res && res.error) || 'Scan failed', true);
        }
      });

      const getBtn = card.querySelector('.p-getkey-btn');
      if (getBtn) {
        getBtn.addEventListener('click', () => api.openExternalUrl(getBtn.dataset.url));
      }

      const delBtn = card.querySelector('.p-del-btn');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          await api.removeProviderKey(pid);
          toast(`Cleared keys for ${pid}`);
          await loadProvidersView();
        });
      }
    });
  }

  // ==================== 6. FREE MODELS & COMBO ROUTER ====================
  async function loadFreeModelsView(fetchLive = false) {
    const fb = await api.getFallbackChain();
    if (fb) {
      $('chkFallbackEnabled').checked = fb.enabled !== false;
      $('fallbackCooldownInput').value = fb.cooldownMinutes || 15;
      $('fallbackChainTextarea').value = (fb.chain || []).join('\n');
    }

    if (fetchLive) {
      $('btnRefreshLiveFree').textContent = 'Fetching…';
    }
    const freeData = fetchLive ? await api.fetchFreeCodingModels() : { curated: null, liveOpenRouter: [] };
    $('btnRefreshLiveFree').textContent = '↻ Fetch Live $0 Models';

    // Always render curated list (fetch once if needed)
    const full = freeData.curated ? freeData : await api.fetchFreeCodingModels();
    const curTbody = $('curatedFreeTable').querySelector('tbody');
    curTbody.innerHTML = ((full && full.curated) || [])
      .map(
        (m) => `<tr>
          <td><span class="badge-ok">${escHtml(m.rank)}</span></td>
          <td><strong>${escHtml(m.name)}</strong><br/><code>${escHtml(m.id)}</code></td>
          <td>${escHtml(m.context)}</td>
          <td class="muted">${escHtml(m.sweScore)}</td>
          <td>
            <button class="btn btn-primary btn-xs use-model-btn" data-model="${escHtml(m.id)}">Use</button>
            <button class="btn btn-secondary btn-xs chain-model-btn" data-model="${escHtml(m.id)}">+ Chain</button>
          </td>
        </tr>`
      )
      .join('');

    if (full && Array.isArray(full.liveOpenRouter) && full.liveOpenRouter.length > 0) {
      const liveTbody = $('liveOpenRouterTable').querySelector('tbody');
      liveTbody.innerHTML = full.liveOpenRouter
        .map(
          (m) => `<tr>
            <td><strong>${escHtml(m.name)}</strong><br/><code>${escHtml(m.id)}</code></td>
            <td>${escHtml(m.context)}</td>
            <td><span class="badge-ok">${escHtml(m.score)}</span></td>
            <td>
              <button class="btn btn-primary btn-xs use-model-btn" data-model="${escHtml(m.id)}">Use</button>
              <button class="btn btn-secondary btn-xs chain-model-btn" data-model="${escHtml(m.id)}">+ Chain</button>
            </td>
          </tr>`
        )
        .join('');
    }

    document.querySelectorAll('#tab-free-models .use-model-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        await api.setDefaultModel(b.dataset.model);
        $('activeModelLabel').textContent = b.dataset.model;
        toast(`Default model set to ${b.dataset.model}`);
      });
    });

    document.querySelectorAll('#tab-free-models .chain-model-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const area = $('fallbackChainTextarea');
        const lines = area.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (!lines.includes(b.dataset.model)) {
          lines.push(b.dataset.model);
          area.value = lines.join('\n');
          toast(`Added ${b.dataset.model} to chain`);
        }
      });
    });
  }

  // ==================== 7. MCP MARKETPLACE & RAW CONFIGS ====================
  async function loadMcpView() {
    const [market, configured, ac, raw] = await Promise.all([
      api.getMcpMarketplace(),
      api.getMcpServers(),
      api.getAgentsAndCommands(),
      api.getRawConfigs()
    ]);

    $('navMcpCount').textContent = String((configured || []).length);

    const mGrid = $('mcpMarketplaceGrid');
    mGrid.innerHTML = (market || [])
      .map(
        (m) => `<div class="item-card ${m.installed ? 'installed' : ''}">
          <div>
            <div class="item-head">
              <strong>${escHtml(m.name)}</strong>
              <span class="${m.installed ? 'badge-ok' : 'badge-miss'}">${m.installed ? '✓ Installed' : escHtml(m.category)}</span>
            </div>
            <div class="muted mt-6">${escHtml(m.description)}</div>
          </div>
          <div class="btn-row mt-8">
            <button class="btn ${m.installed ? 'btn-secondary' : 'btn-primary'} btn-xs mcp-mkt-btn" data-id="${escHtml(m.id)}">
              ${m.installed ? '↻ Re-Sync MCP' : '⚡ 1-Click Enable'}
            </button>
          </div>
        </div>`
      )
      .join('');

    mGrid.querySelectorAll('.mcp-mkt-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api.installMarketplaceMcp(btn.dataset.id);
        toast(`Enabled MCP server: ${btn.dataset.id}`);
        await loadMcpView();
      });
    });

    const cfgWrap = $('configuredMcpList');
    cfgWrap.innerHTML = !(configured || []).length
      ? '<div class="muted">No MCP servers configured yet.</div>'
      : configured
          .map(
            (s) => `<div class="stack-row">
              <div>
                <strong>${escHtml(s.name)}</strong> <span class="muted-label">(${escHtml(s.type)})</span>
                <div class="muted"><code>${escHtml(s.command.slice(0, 75))}</code></div>
              </div>
              <div class="btn-row">
                <button class="btn btn-secondary btn-xs mcp-toggle-btn" data-name="${escHtml(s.name)}" data-en="${s.enabled ? '1' : '0'}">${s.enabled ? 'Enabled' : 'Disabled'}</button>
                <button class="btn btn-danger btn-xs mcp-rm-btn" data-name="${escHtml(s.name)}">✕</button>
              </div>
            </div>`
          )
          .join('');

    cfgWrap.querySelectorAll('.mcp-toggle-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        await api.toggleMcpServer({ name: b.dataset.name, enabled: b.dataset.en !== '1' });
        await loadMcpView();
      });
    });
    cfgWrap.querySelectorAll('.mcp-rm-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        await api.removeMcpServer(b.dataset.name);
        await loadMcpView();
      });
    });

    const agWrap = $('customAgentsList');
    agWrap.innerHTML = ((ac && ac.agents) || [])
      .map(
        (a) => `<div class="stack-row">
          <div><strong>@${escHtml(a.id)}</strong> <span class="muted">${escHtml(a.description.slice(0, 60))}</span></div>
          <button class="btn btn-danger btn-xs del-ag-btn" data-id="${escHtml(a.id)}">✕</button>
        </div>`
      )
      .join('');
    agWrap.querySelectorAll('.del-ag-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        await api.deleteCustomAgent(b.dataset.id);
        await loadMcpView();
      });
    });

    if (raw) {
      $('rawOpencodeJsonc').value = raw.opencodeJsonc || '';
      $('rawCliJson').value = raw.cliJson || '';
      $('rawAgentsMd').value = raw.agentsMd || '';
    }
  }

  // ==================== 8. SKILLS & PLUGINS ====================
  function renderSkillsAndPlugins() {
    if (!state.system) return;
    const sCloud = $('installedSkillsCloud');
    const skills = state.system.skills || [];
    sCloud.innerHTML = skills.length
      ? skills.map((s) => `<button class="chip-btn skill-chip" data-kind="skill" data-name="${escHtml(s)}">📘 ${escHtml(s)}</button>`).join('')
      : '<span class="muted">No skills installed yet.</span>';

    const pCloud = $('installedPluginsCloud');
    const plugins = state.system.plugins || [];
    pCloud.innerHTML = plugins.length
      ? plugins.map((p) => `<button class="chip-btn skill-chip" data-kind="plugin" data-name="${escHtml(p)}">🧩 ${escHtml(p)}</button>`).join('')
      : '<span class="muted">No plugins registered.</span>';

    document.querySelectorAll('.skill-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const res = await api.readSkillOrPluginFile({ kind: chip.dataset.kind, name: chip.dataset.name });
        if (res && res.ok) {
          state.editingItem = { kind: chip.dataset.kind, name: chip.dataset.name };
          $('liveSkillEditorTitle').textContent = `✏ Editing ${chip.dataset.kind}: ${chip.dataset.name}`;
          $('liveSkillEditorArea').value = res.content;
          $('btnSaveSkillFile').disabled = false;
        } else {
          toast((res && res.error) || 'Package managed externally', true);
        }
      });
    });
  }

  // ==================== 9. TURBO PARALLEL INSTALLER ====================
  function renderTurboInstaller() {
    $('portableRootInput').value = state.settings.portableRoot || '';
    $('chkUsePortablePrefix').checked = Boolean(state.settings.usePortablePrefix);
    $('chkSafeGpuMode').checked = Boolean(state.settings.safeGpuMode);

    const prereqs = (state.system && state.system.prereqs) || [];
    const grid = $('turboPrereqsGrid');
    grid.innerHTML = prereqs
      .map((p) => {
        const liveBadge = state.installBadges[p.id];
        const statusHtml = liveBadge
          ? `<span class="badge-ok">${escHtml(liveBadge)}</span>`
          : p.installed
            ? `<span class="badge-ok">✓ ${escHtml(p.version)}</span>`
            : `<span class="badge-miss">Missing</span>`;

        return `<div class="item-card ${p.installed ? 'installed' : ''}">
          <div>
            <div class="item-head">
              <label class="chk-inline" style="color:var(--text);font-weight:700;">
                <input type="checkbox" class="prereq-chk" value="${escHtml(p.id)}" ${!p.installed ? 'checked' : ''} />
                ${escHtml(p.name)}
              </label>
              ${statusHtml}
            </div>
            <div class="muted mt-6">${escHtml(p.description)}</div>
          </div>
        </div>`;
      })
      .join('');
  }

  // ==================== 10. CLOUD SYNC & PROFILES ====================
  async function loadCloudAndProfilesView() {
    const [acct, profiles] = await Promise.all([api.getCloudAccount(), api.getProfiles()]);
    const banner = $('cloudAccountBanner');
    if (acct && acct.signedIn) {
      banner.innerHTML = `✓ Connected to <strong>${escHtml(acct.provider)}</strong> as <strong>${escHtml(acct.displayName || acct.username)}</strong>${
        acct.gistId ? ` • Gist: <code>${escHtml(acct.gistId)}</code>` : ''
      }${acct.lastSyncedAt ? ` • Last synced: ${escHtml(acct.lastSyncedAt.slice(0, 19))}` : ''}`;
    } else {
      banner.textContent = 'Not signed in. Connect a GitHub Gist token or local Google Drive/OneDrive folder.';
    }

    const pWrap = $('profilesList');
    pWrap.innerHTML = !(profiles || []).length
      ? '<div class="muted">No saved profiles yet.</div>'
      : profiles
          .map(
            (name) => `<div class="stack-row">
              <strong>🗂 ${escHtml(name)}</strong>
              <button class="btn btn-secondary btn-xs switch-prof-btn" data-name="${escHtml(name)}">Activate Profile</button>
            </div>`
          )
          .join('');

    pWrap.querySelectorAll('.switch-prof-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        const res = await api.switchProfile(b.dataset.name);
        if (res && res.ok) {
          toast(`Activated profile: ${b.dataset.name}`);
          applySystemStatusToUI(await api.getSystemStatus(true));
        }
      });
    });
  }

  // ==================== 11. BUG REPORTER ====================
  async function loadBugsView() {
    const bugs = await api.getBugReports();
    const badge = $('navBugsCount');
    if (bugs && bugs.length > 0) {
      badge.textContent = String(bugs.length);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    const wrap = $('capturedBugsList');
    if (!wrap) return;
    wrap.innerHTML = !(bugs || []).length
      ? '<div class="muted">Zero runtime errors captured.</div>'
      : bugs
          .map(
            (b) => `<div class="stack-row">
              <div>
                <strong>${escHtml(b.title)}</strong>
                <div class="muted">${escHtml((b.ts || '').slice(0, 19))} • ${escHtml(b.source)}</div>
              </div>
              <button class="btn btn-secondary btn-xs fill-bug-btn" data-title="${escHtml(b.title)}" data-detail="${escHtml(b.detail)}">Load</button>
            </div>`
          )
          .join('');

    wrap.querySelectorAll('.fill-bug-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('bugTitleInput').value = btn.dataset.title;
        $('bugDescInput').value = btn.dataset.detail;
      });
    });
  }

  // ==================== CTRL+K COMMAND PALETTE ====================
  const PALETTE_COMMANDS = [
    { label: '🤖 Open Live Agent Studio', run: () => switchTab('agent-studio') },
    { label: '⚔ Start Dual-Model Arena Race', run: () => { switchTab('agent-studio'); $('agentEngineSelect').value = 'arena'; $('agentEngineSelect').dispatchEvent(new Event('change')); } },
    { label: '🕸 Open Multi-Agent Hub', run: () => switchTab('agents-hub') },
    { label: '⚡ 1-Click Install @opendocflow Agent Team + MCP', run: () => $('btnInstallOdfSuite').click() },
    { label: '📄 Open DocFlow Repo Packager & AI Docs', run: () => switchTab('docflow') },
    { label: '🏎 Run Live Provider Speed Benchmark (tok/s)', run: async () => { await switchTab('gateway'); executeBenchmark(true); } },
    { label: '🔑 Open AI Keys & Multi-Key Pool Vault', run: () => switchTab('providers') },
    { label: '🔄 Rotate to Next Free Model in Combo Chain', run: () => $('btnRotateModelQuick').click() },
    { label: '🔌 Open 1-Click MCP Server Marketplace', run: () => switchTab('mcp') },
    { label: '🌍 Open World Skills & Cross-Agent Sync', run: () => switchTab('skills') },
    { label: '🚀 Open Turbo Parallel All-Tools Installer', run: () => switchTab('installer') },
    { label: '▶ Launch OpenCode V2 in External Terminal', run: () => $('btnLaunchOpenCodeTop').click() }
  ];

  function openPalette() {
    $('paletteModal').classList.remove('hidden');
    $('paletteSearchInput').value = '';
    renderPaletteList('');
    $('paletteSearchInput').focus();
  }

  function closePalette() {
    $('paletteModal').classList.add('hidden');
  }

  function renderPaletteList(query) {
    const q = query.trim().toLowerCase();
    const filtered = PALETTE_COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q));
    const list = $('paletteResultsList');
    list.innerHTML = filtered
      .map((c, idx) => `<button class="palette-item${idx === 0 ? ' selected' : ''}" data-idx="${idx}">${escHtml(c.label)}</button>`)
      .join('');

    list.querySelectorAll('.palette-item').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        closePalette();
        filtered[i].run();
      });
    });
  }

  // ==================== GLOBAL EVENT WIRING ====================
  function wireGlobalEvents() {
    // Sidebar nav
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.querySelectorAll('[data-jump]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.jump));
    });

    $('btnToggleSidebar').addEventListener('click', () => {
      $('leftSidebar').classList.toggle('collapsed');
    });

    $('btnToggleInspector').addEventListener('click', () => {
      $('rightInspector').classList.toggle('collapsed');
    });
    $('btnCloseInspector').addEventListener('click', () => {
      $('rightInspector').classList.add('collapsed');
    });

    $('headerModelPill').addEventListener('click', () => switchTab('free-models'));

    $('btnLaunchOpenCodeTop').addEventListener('click', async () => {
      const cwd = $('agentWorkspaceInput').value.trim() || '';
      await api.launchCliAgentExternal({ cmd: 'opencode', cwd });
      toast('Launched OpenCode V2 in GPU Terminal');
    });

    $('btnRotateModelQuick').addEventListener('click', async () => {
      const res = await api.triggerNextFreeModelNow();
      if (res && res.ok) {
        $('activeModelLabel').textContent = res.toModel;
        toast(`Switched active model → ${res.toModel}`);
      }
    });

    // Multi-Agent Hub actions
    $('btnInstallOdfSuite').addEventListener('click', async () => {
      const res = await api.installOpenDocFlowAgentSuite();
      if (res && res.ok) {
        toast(`Installed ${res.agentsInstalled} @opendocflow agents, ${res.commandsInstalled} slash commands & Native MCP!`);
        applySystemStatusToUI(await api.getSystemStatus(true));
      }
    });
    $('btnWireAllIdesHub').addEventListener('click', async () => {
      await api.connectAllIdesToGateway();
      toast('Wired OpenCode, Claude Code, Codex, Gemini & Aider to :4141/v1!');
    });
    $('btnRefreshAgentsHub').addEventListener('click', loadAgentsHubView);

    // Gateway & Benchmark actions
    $('btnRunBenchmark').addEventListener('click', () => executeBenchmark(false));
    $('btnRunBenchmarkAndSort').addEventListener('click', () => executeBenchmark(true));
    $('gwStrategySelect').addEventListener('change', () => {
      api.updateGatewaySettings({ strategy: $('gwStrategySelect').value });
    });
    $('chkGwCompression').addEventListener('change', () => {
      api.updateGatewaySettings({ compressionEnabled: $('chkGwCompression').checked });
    });
    $('chkGwCache').addEventListener('change', () => {
      api.updateGatewaySettings({ promptCacheEnabled: $('chkGwCache').checked });
    });
    $('chkGwAutoBug').addEventListener('change', () => {
      api.updateGatewaySettings({ autoBugReport: $('chkGwAutoBug').checked });
    });
    $('btnClearPromptCache').addEventListener('click', async () => {
      await api.clearPromptCache();
      toast('Cleared 0ms prompt cache');
    });
    $('btnConnectOpenCodeGw').addEventListener('click', async () => {
      const res = await api.connectLocalGatewayToOpenCode();
      if (res && res.ok) {
        $('activeModelLabel').textContent = res.model;
        toast('Connected OpenCode V2 to :4141/v1');
      }
    });
    $('btnConnectAllIdesGw').addEventListener('click', async () => {
      await api.connectAllIdesToGateway();
      toast('Connected all IDEs & CLI agents to :4141/v1');
    });
    $('btnResetGraphLayout').addEventListener('click', async () => {
      state.nodeGraph = JSON.parse(JSON.stringify(DEFAULT_GRAPH_NODES));
      await api.saveNodeGraphLayout(state.nodeGraph);
      renderGraphNodes();
    });

    $('btnApplyQuickModel').addEventListener('click', async () => {
      const m = $('quickModelInput').value.trim();
      if (!m) return;
      await api.setDefaultModel(m);
      $('activeModelLabel').textContent = m;
      toast(`Active model updated to ${m}`);
    });

    $('btnBrowseNewProj').addEventListener('click', async () => {
      const dir = await api.pickDirectory();
      if (dir) $('newProjPathInput').value = dir;
    });
    $('btnCreateNewProj').addEventListener('click', async () => {
      const p = $('newProjPathInput').value.trim();
      if (!p) return toast('Choose a project path first', true);
      await api.createNewProject({ path: p, skillQuery: $('newProjSkillInput').value.trim() });
      toast(`Created AI project at ${p}`);
    });

    // Providers Scanner & Custom Model
    $('providerSearchInput').addEventListener('input', renderProviderCards);
    $('chkFilterConfigured').addEventListener('change', renderProviderCards);
    $('btnScanKeyNow').addEventListener('click', async () => {
      const id = $('scanProviderSelect').value;
      const apiKey = $('scanKeyInput').value.trim();
      $('scanResultBox').textContent = `Querying live /models endpoint for ${id}…`;
      const res = await api.discoverModelsFromKey({ id, apiKey });
      if (res && res.ok) {
        $('scanResultBox').textContent = `✓ Discovered & wired ${res.count} models: ${res.models.slice(0, 8).join(', ')}`;
        await loadProvidersView();
      } else {
        $('scanResultBox').textContent = `⚠ ${(res && res.error) || 'Failed scanning key'}`;
      }
    });

    $('btnAddCustomModel').addEventListener('click', async () => {
      const providerId = $('custProviderId').value.trim();
      const modelId = $('custModelId').value.trim();
      if (!providerId || !modelId) return toast('Enter provider ID and model ID', true);
      const res = await api.addCustomModel({
        providerId,
        modelId,
        baseURL: $('custBaseUrl').value.trim(),
        setAsDefault: $('chkCustDefault').checked
      });
      if (res && res.ok) {
        toast(`Added ${res.fullRef}`);
        if ($('chkCustDefault').checked) $('activeModelLabel').textContent = res.fullRef;
      }
    });

    // Free Models Router
    $('btnForceNextFreeModel').addEventListener('click', () => $('btnRotateModelQuick').click());
    $('btnSaveFallbackChain').addEventListener('click', async () => {
      const chain = $('fallbackChainTextarea').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await api.saveFallbackChain({
        enabled: $('chkFallbackEnabled').checked,
        cooldownMinutes: Number($('fallbackCooldownInput').value) || 15,
        chain
      });
      toast(`Saved ${chain.length} models in Self-Healing Combo Chain`);
    });
    $('btnRefreshLiveFree').addEventListener('click', () => loadFreeModelsView(true));

    // MCP & Configs
    $('btnRefreshMcpTab').addEventListener('click', loadMcpView);
    $('btnAddCustomMcp').addEventListener('click', async () => {
      const res = await api.addMcpServer({
        name: $('customMcpName').value,
        commandOrUrl: $('customMcpCmd').value
      });
      if (res && res.ok) {
        $('customMcpName').value = '';
        $('customMcpCmd').value = '';
        toast(`Added MCP server ${res.name}`);
        await loadMcpView();
      }
    });
    $('btnSaveCustomAgent').addEventListener('click', async () => {
      const res = await api.saveCustomAgent({
        id: $('custAgentId').value,
        model: $('custAgentModel').value,
        description: $('custAgentDesc').value,
        system: $('custAgentSys').value,
        readOnly: $('chkCustAgentReadOnly').checked
      });
      if (res && res.ok) {
        toast(`Saved @${res.id} subagent`);
        await loadMcpView();
      }
    });
    $('btnReloadRawConfigs').addEventListener('click', loadMcpView);
    $('btnSaveRawConfigs').addEventListener('click', async () => {
      await api.saveRawConfigs({
        opencodeJsonc: $('rawOpencodeJsonc').value,
        cliJson: $('rawCliJson').value,
        agentsMd: $('rawAgentsMd').value
      });
      toast('Saved opencode.jsonc, cli.json & AGENTS.md');
    });

    // Skills & Plugins
    $('btnImportUniversalSkill').addEventListener('click', async () => {
      const res = await api.importUniversalSkill({
        source: $('univSkillSource').value,
        skillName: $('univSkillName').value,
        rawContent: $('univSkillRaw').value,
        syncAllAgents: $('chkSyncSkillEverywhere').checked
      });
      if (res && res.ok) {
        toast(`Imported skill: ${res.skillId}`);
        applySystemStatusToUI(await api.getSystemStatus(true));
      } else {
        toast((res && res.error) || 'Import failed', true);
      }
    });
    $('btnSyncAllPcSkills').addEventListener('click', async () => {
      const res = await api.syncAllAgentsSkills();
      if (res && res.ok) {
        toast(`Unified ${res.count} skills across OpenCode, Claude, Codex & Gemini!`);
        applySystemStatusToUI(await api.getSystemStatus(true));
      }
    });
    $('btnBulkImportSkills').addEventListener('click', async () => {
      const res = await api.bulkImportSkillUrls($('bulkSkillUrlsInput').value);
      if (res && res.ok) {
        toast(`Imported ${res.count} skills in parallel!`);
        applySystemStatusToUI(await api.getSystemStatus(true));
      }
    });
    $('btnInstallPlugin').addEventListener('click', async () => {
      const res = await api.installUniversalPlugin({ spec: $('univPluginSpec').value, wrapV2: true });
      if (res && res.ok) {
        toast(`Installed plugin (${res.method})`);
        applySystemStatusToUI(await api.getSystemStatus(true));
      }
    });
    $('btnSearchSkillsCli').addEventListener('click', async () => {
      const q = $('skillRegistryQuery').value.trim();
      if (q) await api.searchSkills(q);
    });
    $('btnSaveSkillFile').addEventListener('click', async () => {
      if (!state.editingItem) return;
      await api.saveSkillOrPluginFile({
        ...state.editingItem,
        content: $('liveSkillEditorArea').value
      });
      toast(`Saved ${state.editingItem.name}`);
    });

    // Turbo Parallel Installer
    $('btnPickPortableRoot').addEventListener('click', async () => {
      const dir = await api.pickDirectory();
      if (dir) {
        $('portableRootInput').value = dir;
        $('chkUsePortablePrefix').checked = true;
      }
    });
    $('btnSaveInstallerSettings').addEventListener('click', async () => {
      const res = await api.saveStudioSettings({
        portableRoot: $('portableRootInput').value.trim(),
        usePortablePrefix: $('chkUsePortablePrefix').checked,
        safeGpuMode: $('chkSafeGpuMode').checked
      });
      if (res && res.settings) {
        state.settings = res.settings;
        toast('Saved portable & GPU settings');
        applySystemStatusToUI(await api.getSystemStatus(true));
      }
    });
    $('btnCreateShortcut').addEventListener('click', async () => {
      const res = await api.createDesktopShortcut();
      toast(res && res.ok ? 'Created Desktop shortcut!' : 'Shortcut failed', !(res && res.ok));
    });
    $('btnSelectMissingPrereqs').addEventListener('click', () => {
      renderTurboInstaller();
    });
    $('btnTurboInstallSelected').addEventListener('click', async () => {
      const ids = Array.from(document.querySelectorAll('.prereq-chk:checked')).map((c) => c.value);
      if (!ids.length) return toast('Select at least one component to install');
      $('btnTurboInstallSelected').disabled = true;
      toast(`Running Turbo Parallel Installer for ${ids.length} tools…`);
      await api.installPrerequisites(ids, {
        portableRoot: $('portableRootInput').value.trim(),
        usePortablePrefix: $('chkUsePortablePrefix').checked
      });
      $('btnTurboInstallSelected').disabled = false;
      applySystemStatusToUI(await api.getSystemStatus(true));
      toast('Turbo installation completed!');
    });
    $('btnRunKitRestore').addEventListener('click', async () => {
      toast('Restoring portable setup-kit…');
      await api.runFullKitRestore();
      applySystemStatusToUI(await api.getSystemStatus(true));
      toast('Setup-kit restored safely!');
    });
    $('btnUpdateKitSnapshot').addEventListener('click', async () => {
      await api.updatePortableKit();
      toast('Snapshot saved to setup-kit!');
    });

    // Cloud & Profiles
    $('btnCloudSignIn').addEventListener('click', async () => {
      const provider = $('cloudProviderSelect').value;
      const val = $('cloudTokenOrFolderInput').value.trim();
      const res = await api.signInCloud(provider === 'github' ? { provider, token: val } : { provider, syncFolder: val });
      if (res && res.ok) {
        toast('Cloud sync connected!');
        await loadCloudAndProfilesView();
      } else {
        toast((res && (res.message || res.error)) || 'Sign-in needs token', !res.needsToken);
      }
    });
    $('btnCloudSignOut').addEventListener('click', async () => {
      await api.signOutCloud();
      await loadCloudAndProfilesView();
    });
    $('btnCloudPush').addEventListener('click', async () => {
      const res = await api.pushCloudSync({ passphrase: $('cloudPassphraseInput').value });
      toast(res && res.ok ? 'Pushed AES-256-GCM cloud sync!' : (res && res.error) || 'Push failed', !(res && res.ok));
      await loadCloudAndProfilesView();
    });
    $('btnCloudPull').addEventListener('click', async () => {
      const res = await api.pullCloudSync({
        passphrase: $('cloudPassphraseInput').value,
        gistId: $('cloudGistIdInput').value
      });
      if (res && res.ok) {
        toast('Restored workspace from cloud sync!');
        applySystemStatusToUI(await api.getSystemStatus(true));
      } else {
        toast((res && res.error) || 'Pull failed', true);
      }
    });
    $('btnSaveProfile').addEventListener('click', async () => {
      const name = $('newProfileNameInput').value.trim();
      if (!name) return;
      await api.saveProfileSnapshot(name);
      $('newProfileNameInput').value = '';
      toast(`Saved profile ${name}`);
      await loadCloudAndProfilesView();
    });

    // Bugs
    $('btnSubmitBugGithub').addEventListener('click', async () => {
      const res = await api.reportBugToGitHub({
        title: $('bugTitleInput').value,
        description: $('bugDescInput').value,
        steps: $('bugStepsInput').value
      });
      if (res && res.ok) toast('Opened/submitted redacted GitHub issue!');
    });
    $('btnClearBugs').addEventListener('click', async () => {
      await api.clearBugReports();
      await loadBugsView();
    });

    // Bottom Dock
    document.querySelectorAll('.dock-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.dock-tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.dock-pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        $(`dock-${tab.dataset.dock}`).classList.add('active');
        $('bottomDock').classList.remove('collapsed');
      });
    });

    $('btnToggleDockHeight').addEventListener('click', () => {
      $('bottomDock').classList.toggle('collapsed');
    });
    $('btnClearConsole').addEventListener('click', () => {
      $('dock-console').textContent = '';
    });
    const execDockCmd = async () => {
      const cmd = $('consoleCmdInput').value.trim();
      if (!cmd) return;
      $('consoleCmdInput').value = '';
      await api.runTerminalCommand(cmd, $('agentWorkspaceInput').value.trim() || '');
    };
    $('btnRunConsoleCmd').addEventListener('click', execDockCmd);
    $('consoleCmdInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') execDockCmd();
    });
    $('btnStopConsoleCmd').addEventListener('click', () => api.stopTerminalCommand());

    // Inspector quick buttons
    $('btnOpenConfigDir').addEventListener('click', () => {
      if (state.system && state.system.configDir) api.openPath(state.system.configDir);
    });
    $('btnCheckUpdatesManual').addEventListener('click', async () => {
      toast('Checking npm registry for component updates…');
      const u = await api.checkUpdates();
      if (u && u.updatesAvailable) {
        $('btnSilentUpdates').classList.remove('hidden');
        toast('Component updates available — click ⬆ Updates in topbar');
      } else {
        toast('All components are up to date!');
      }
    });
    $('btnSilentUpdates').addEventListener('click', async () => {
      toast('Updating OpenCode V2, plugins & REA in parallel…');
      await api.updateAllComponents();
      $('btnSilentUpdates').classList.add('hidden');
      toast('All components updated!');
    });

    // Command Palette shortcuts
    $('btnOpenPalette').addEventListener('click', openPalette);
    $('paletteModal').addEventListener('click', (e) => {
      if (e.target === $('paletteModal')) closePalette();
    });
    $('paletteSearchInput').addEventListener('input', (e) => renderPaletteList(e.target.value));
    $('paletteSearchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePalette();
      if (e.key === 'Enter') {
        const first = $('paletteResultsList').querySelector('.palette-item');
        if (first) first.click();
      }
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        $('leftSidebar').classList.toggle('collapsed');
      } else if (e.key === 'Escape' && !$('paletteModal').classList.contains('hidden')) {
        closePalette();
      }
    });

    // Live IPC Subscriptions
    api.onTerminalData((d) => {
      if (d && d.text) appendConsole(d.text);
    });
    api.onAgentStream(handleAgentStreamChunk);
    api.onInstallProgress((prog) => {
      if (!prog || !prog.id) return;
      state.installBadges[prog.id] =
        prog.status === 'installing' ? 'Installing…' : prog.status === 'done' ? '✓ Done' : prog.status === 'queued' ? 'Queued' : 'Failed';
      if (state.loadedTabs.has('installer')) renderTurboInstaller();
      if (state.loadedTabs.has('agents-hub') && state.agentsHub) renderAgentsHub(state.agentsHub);
    });
    api.onGatewayEvent(async () => {
      const tel = await api.getGatewayTelemetry();
      applyTelemetryToUI(tel);
    });
    api.onBugCaptured(() => {
      loadBugsView();
    });
  }

  // ==================== INSTANT <15ms BOOT ====================
  async function boot() {
    setupAgentStudio();
    setupDocFlowStudio();
    wireGlobalEvents();

    const [settings, sys, tel, hub, prov] = await Promise.all([
      api.getStudioSettings(),
      api.getSystemStatus(false),
      api.getGatewayTelemetry(),
      api.getAgentsHub(),
      api.getProvidersState()
    ]);

    if (settings) state.settings = settings;
    applySystemStatusToUI(sys);
    applyTelemetryToUI(tel);
    if (hub) {
      state.agentsHub = hub;
      const inst = (hub.agents || []).filter((a) => a.installed).length;
      $('navAgentsCount').textContent = `${inst}/${(hub.agents || []).length}`;
    }
    if (prov) {
      state.providersData = prov;
      $('navKeysCount').textContent = String((prov.providers || []).filter((p) => p.hasKey).length);
    }

    // Silent non-blocking update check after 4.5s idle (never pops up a modal!)
    setTimeout(async () => {
      try {
        const u = await api.checkUpdates();
        if (u && u.updatesAvailable) {
          $('btnSilentUpdates').classList.remove('hidden');
        }
      } catch (_) {}
    }, 4500);
  }

  boot();
})();
