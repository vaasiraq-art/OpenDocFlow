let systemState = null;

function appendTerm(text) {
  const out = document.getElementById('terminalOutput');
  if (!out) return;
  const clean = String(text).replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  out.textContent += clean;
  if (out.textContent.length > 48000) {
    out.textContent = out.textContent.slice(-36000);
  }
  out.scrollTop = out.scrollHeight;
}

window.studioAPI.onTerminalData((msg) => {
  appendTerm(msg.text);
});

window.studioAPI.onBugCaptured((bug) => {
  appendTerm(`\n[Auto-Bug Catcher recorded: ${bug.title}]\n`);
  refreshBugReports();
});

// ============================================================================
// FLOATING BUTTON INFO TOOLTIP + STATUSBAR HOVER HELP
// ============================================================================
const tooltipEl = document.getElementById('studioTooltip');
const statusHoverEl = document.getElementById('statusHoverHelp');

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest('[data-info]');
  if (!target) {
    if (tooltipEl) tooltipEl.classList.add('hidden');
    return;
  }
  const infoText = target.getAttribute('data-info');
  if (!infoText) return;

  if (statusHoverEl) {
    statusHoverEl.textContent = infoText;
  }
  if (tooltipEl) {
    tooltipEl.textContent = infoText;
    tooltipEl.classList.remove('hidden');
    const rect = target.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 7;
    if (left + 320 > window.innerWidth) left = window.innerWidth - 330;
    if (top + 70 > window.innerHeight) top = rect.top - 58;
    tooltipEl.style.left = `${Math.max(8, left)}px`;
    tooltipEl.style.top = `${Math.max(8, top)}px`;
  }
});

document.addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-info]')) {
    if (tooltipEl) tooltipEl.classList.add('hidden');
  }
});

// ============================================================================
// INTERACTIVE DRAGGABLE ROUTING PIPELINE NODES + SVG BEZIER CONNECTIONS
// ============================================================================
const DEFAULT_NODE_POS = {
  n1: { left: 14, top: 20 },
  n2: { left: 235, top: 20 },
  n3: { left: 458, top: 20 },
  n4: { left: 682, top: 14 }
};

function drawNodeBezierWires() {
  const svg = document.getElementById('nodeWiresSvg');
  const stage = document.getElementById('nodeGraphStage');
  if (!svg || !stage) return;

  const pairs = [
    ['n1', 'n2', '#ff8c32'],
    ['n2', 'n3', '#9b6bcc'],
    ['n3', 'n4', '#5fb878']
  ];

  let pathsHtml = '';
  for (const [fromId, toId, color] of pairs) {
    const nA = stage.querySelector(`.draggable-node[data-node-id="${fromId}"]`);
    const nB = stage.querySelector(`.draggable-node[data-node-id="${toId}"]`);
    if (!nA || !nB) continue;

    const x1 = nA.offsetLeft + nA.offsetWidth;
    const y1 = nA.offsetTop + 16;
    const x2 = nB.offsetLeft;
    const y2 = nB.offsetTop + 16;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);

    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    pathsHtml += `<path d="${d}" stroke="${color}" stroke-width="2.6" fill="none" stroke-linecap="round" />`;
  }
  svg.innerHTML = pathsHtml;
}

function initDraggableNodes() {
  const stage = document.getElementById('nodeGraphStage');
  if (!stage) return;

  let activeNode = null;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  stage.querySelectorAll('.draggable-node').forEach((node) => {
    node.addEventListener('mousedown', (e) => {
      activeNode = node;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = node.offsetLeft;
      origTop = node.offsetTop;
      e.preventDefault();
    });
  });

  window.addEventListener('mousemove', (e) => {
    if (!activeNode) return;
    const nx = Math.max(4, Math.min(stage.clientWidth - activeNode.offsetWidth - 4, origLeft + (e.clientX - startX)));
    const ny = Math.max(4, Math.min(stage.clientHeight - activeNode.offsetHeight - 4, origTop + (e.clientY - startY)));
    activeNode.style.left = `${nx}px`;
    activeNode.style.top = `${ny}px`;
    drawNodeBezierWires();
  });

  window.addEventListener('mouseup', () => {
    if (!activeNode) return;
    activeNode = null;
    const layout = {};
    stage.querySelectorAll('.draggable-node').forEach((n) => {
      layout[n.dataset.nodeId] = { left: n.offsetLeft, top: n.offsetTop };
    });
    window.studioAPI.saveNodeGraphLayout(layout);
  });

  document.getElementById('btnResetNodePositions').addEventListener('click', () => {
    stage.querySelectorAll('.draggable-node').forEach((n) => {
      const def = DEFAULT_NODE_POS[n.dataset.nodeId];
      if (def) {
        n.style.left = `${def.left}px`;
        n.style.top = `${def.top}px`;
      }
    });
    drawNodeBezierWires();
    window.studioAPI.saveNodeGraphLayout(DEFAULT_NODE_POS);
  });

  window.addEventListener('resize', drawNodeBezierWires);
}

async function loadSavedNodePositions() {
  const saved = await window.studioAPI.getNodeGraphLayout();
  const stage = document.getElementById('nodeGraphStage');
  if (saved && stage) {
    stage.querySelectorAll('.draggable-node').forEach((n) => {
      const pos = saved[n.dataset.nodeId];
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        n.style.left = `${pos.left}px`;
        n.style.top = `${pos.top}px`;
      }
    });
  }
  setTimeout(drawNodeBezierWires, 60);
}

const TAB_TITLES = {
  dashboard: 'AI Agent Gateway & Visual Routing Pipeline',
  guide: '📘 Complete Step-by-Step User Guide (Beginner to Pro)',
  router: 'Smart Combo Router & Auto-Failover Chain',
  keys: 'AI Keys, Multi-Key Pool & Live API Key Model Scanner',
  'free-models': 'Ranked Free Coding Models — Best (S+) to Low',
  skills: 'Universal World Skill & Plugin Harvester (Claude, Codex, Cursor, Web)',
  cloud: 'Cloud Sign-In (GitHub / Google) & Cross-PC AES-256 Sync',
  prereqs: 'System & Device Drivers Wizard (OpenCode, Node, ADB, REA, Graphify)',
  bugs: 'Auto Bug Catcher & 1-Click GitHub Issue Reporter',
  'terminal-tab': 'CLI Command Presets & External TUI'
};

function switchTab(tabId) {
  document.querySelectorAll('.st-ws-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });
  const headerLbl = document.getElementById('viewportHeaderLabel');
  if (headerLbl) headerLbl.textContent = TAB_TITLES[tabId] || 'Studio Workspace';
  if (tabId === 'dashboard') setTimeout(drawNodeBezierWires, 30);
}

document.querySelectorAll('.st-ws-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.querySelectorAll('.guide-jump-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.jump));
});

document.getElementById('btnOpenGuideQuick').addEventListener('click', () => switchTab('guide'));

async function refreshSystemStatus() {
  const st = await window.studioAPI.getSystemStatus();
  if (!st) return;
  systemState = st;

  document.getElementById('sidebarActiveModel').textContent = st.currentModel;
  document.getElementById('inpQuickModel').value =
    st.currentModel === 'Default (Provider Default)' ? '' : st.currentModel;

  const oc = st.prereqs.find((p) => p.id === 'opencode');
  document.getElementById('statOpenCode').textContent = oc && oc.installed ? 'v2.0.22+' : 'Missing';
  document.getElementById('statPlugins').textContent = st.plugins.length;
  document.getElementById('statSkills').textContent = st.skills.length;
  document.getElementById('statMcp').textContent = st.mcpServers.length;

  renderPrereqs(st.prereqs);
  renderPills(st.plugins, st.mcpServers, st.skills);
}

function renderPrereqs(prereqs = []) {
  const container = document.getElementById('prereqsList');
  if (!container) return;
  container.innerHTML = '';
  for (const item of prereqs) {
    const div = document.createElement('div');
    div.className = 'prereq-item';
    div.innerHTML = `
      <input type="checkbox" class="prereq-check" data-id="${item.id}" ${!item.installed ? 'checked' : ''} aria-label="${item.name}" />
      <div class="prereq-info">
        <div class="prereq-title">
          <span>${item.name}</span>
          <span class="status-badge ${item.installed ? 'ok' : 'missing'}">
            ${item.installed ? 'Installed' : 'Needs Install'}
          </span>
        </div>
        <div style="font-size:11px; color:#ff8c32; margin: 2px 0;">${item.category} • ${item.version}</div>
        <div style="font-size:11.5px; color:#9d9d9d;">${item.description}</div>
      </div>
    `;
    container.appendChild(div);
  }
}

let currentlyEditingSkill = null;

function renderPills(plugins = [], mcps = [], skills = []) {
  const pWrap = document.getElementById('pillsPlugins');
  if (pWrap) {
    pWrap.innerHTML = '';
    [...plugins.map((p) => `Plugin: ${p}`), ...mcps.map((m) => `MCP: ${m}`)].forEach((label) => {
      const s = document.createElement('span');
      s.className = 'pill';
      s.textContent = label;
      pWrap.appendChild(s);
    });
  }

  const sWrap = document.getElementById('pillsSkills');
  if (sWrap) {
    sWrap.innerHTML = '';
    skills.forEach((sk) => {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.textContent = sk;
      btn.setAttribute('data-info', `Click to open and edit ${sk}/SKILL.md in the live editor below.`);
      btn.addEventListener('click', async () => {
        const res = await window.studioAPI.readSkillOrPluginFile({ kind: 'skill', name: sk });
        if (res.ok) {
          currentlyEditingSkill = sk;
          document.getElementById('lblEditingItem').textContent = `${sk}/SKILL.md`;
          document.getElementById('txtSkillFileEditor').value = res.content;
        }
      });
      sWrap.appendChild(btn);
    });
  }
}

async function refreshGatewayTelemetry() {
  const gw = await window.studioAPI.getGatewayTelemetry();
  if (!gw) return;

  document.getElementById('inspReqCount').textContent = gw.requestsTotal;
  document.getElementById('inspCacheHits').textContent = gw.cacheHits || 0;
  document.getElementById('inspFailovers').textContent = gw.failoversSaved;
  document.getElementById('inspTokensSaved').textContent = gw.tokensSaved;
  document.getElementById('inspLatency').textContent = `${gw.avgLatencyMs || 0} ms`;

  document.getElementById('nodeTokensSaved').textContent = gw.tokensSaved;
  document.getElementById('nodeCacheHits').textContent = gw.cacheHits || 0;
  document.getElementById('nodeFailoversCount').textContent = gw.failoversSaved;
  document.getElementById('nodeAvgLatency').textContent = `${gw.avgLatencyMs || 0} ms`;
  document.getElementById('nodeStrategyLabel').textContent = gw.strategy;

  document.getElementById('selGatewayStrategy').value = gw.strategy;
  document.getElementById('chkTokenCompress').checked = gw.compressionEnabled;
  document.getElementById('chkPromptCache').checked = gw.promptCacheEnabled !== false;
  document.getElementById('chkAutoBugCapture').checked = gw.autoBugReport;

  if (gw.recentEvents && gw.recentEvents.length > 0) {
    document.getElementById('statusLastEvent').textContent = gw.recentEvents[0].detail;
  }
}

async function refreshProviders() {
  const data = await window.studioAPI.getProvidersState();
  if (!data) return;
  document.getElementById('sidebarActiveModel').textContent = data.currentModel || 'Default (Provider Default)';

  const grid = document.getElementById('providersGrid');
  grid.innerHTML = '';
  for (const p of data.providers) {
    const card = document.createElement('div');
    card.className = 'provider-card';
    const modelOptions = (p.models || [])
      .slice(0, 8)
      .map(
        (m) =>
          `<button class="chip model-select-btn" data-model="${p.id}/${m}" data-info="Click to set ${p.id}/${m} as your active OpenCode model.">${m}</button>`
      )
      .join('');

    const badgeTxt = p.localNoKey
      ? 'Local Ready'
      : p.hasKey
      ? `${p.keyCount || 1} Key(s) Pool`
      : 'No Key';

    card.innerHTML = `
      <div class="provider-top">
        <div>
          <div class="provider-name">${p.name}</div>
          <div class="provider-tier">${p.tier} • <code translate="no">${p.id}</code></div>
        </div>
        <span class="status-badge ${p.hasKey || p.localNoKey ? 'ok' : 'missing'}">${badgeTxt}</span>
      </div>
      <div class="form-row" style="margin-bottom:4px;">
        <label>${p.localNoKey ? 'Optional Bearer Key' : `API Key(s) (${p.envKey}) — 1 or Multiple`}</label>
        <input type="password" class="prov-key-inp" data-id="${p.id}" autocomplete="off" placeholder="${
          p.hasKey ? '•••••••••••••••• (Saved Pool)' : 'Paste API key…'
        }" />
      </div>
      <div class="form-row" style="margin-bottom:4px;">
        <label>Endpoint Base URL</label>
        <input type="url" class="prov-url-inp" data-id="${p.id}" autocomplete="off" spellcheck="false" value="${
          p.baseURL || ''
        }" placeholder="Default Official Endpoint…" />
      </div>
      <div class="quick-chips">${modelOptions}</div>
      <div class="btn-row" style="margin-top:auto; padding-top:4px;">
        <button class="st-btn st-btn-orange btn-save-prov" data-id="${p.id}" data-name="${p.name}" data-env="${
          p.envKey
        }" data-builtin="${p.builtin}" data-info="Save API key(s) and endpoint for ${p.name}.">
          Save Key
        </button>
        <button class="st-btn st-btn-blue btn-scan-prov" data-id="${p.id}" data-info="Connect with your ${
          p.name
        } key and discover all models unlocked by this key.">
          🔍 Scan Key
        </button>
        ${
          p.keyUrl
            ? `<button class="st-btn st-btn-default btn-get-key" data-url="${p.keyUrl}" data-info="Open ${p.name} dashboard in browser to get an API key.">Get Key</button>`
            : ''
        }
        ${
          p.hasKey
            ? `<button class="st-btn st-btn-danger btn-del-prov" data-id="${p.id}" data-info="Remove saved key(s) for ${p.name}.">Clear</button>`
            : ''
        }
      </div>
    `;
    grid.appendChild(card);
  }

  grid.querySelectorAll('.btn-save-prov').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const keyInp = grid.querySelector(`.prov-key-inp[data-id="${id}"]`);
      const urlInp = grid.querySelector(`.prov-url-inp[data-id="${id}"]`);
      await window.studioAPI.saveProviderKey({
        id,
        name: btn.dataset.name,
        envKey: btn.dataset.env,
        builtin: btn.dataset.builtin === 'true',
        apiKey: keyInp.value,
        baseURL: urlInp.value
      });
      appendTerm(`\n[Saved provider configuration for ${id}]\n`);
      await refreshProviders();
    });
  });

  grid.querySelectorAll('.btn-scan-prov').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const keyInp = grid.querySelector(`.prov-key-inp[data-id="${id}"]`);
      const urlInp = grid.querySelector(`.prov-url-inp[data-id="${id}"]`);
      appendTerm(`\n[Scanning live models unlocked by key for ${id}…]\n`);
      const res = await window.studioAPI.discoverModelsFromKey({
        id,
        apiKey: keyInp.value,
        baseURL: urlInp.value
      });
      if (res.ok && res.models && res.models.length > 0) {
        appendTerm(`\n[Discovered ${res.count} models on ${id}: ${res.models.slice(0, 10).join(', ')}…]\n`);
        showScannedModelsBox(res.providerId, res.models);
        await refreshProviders();
      } else {
        appendTerm(`\n[Scan note for ${id}: ${res.error || 'No models returned'}]\n`);
      }
    });
  });

  grid.querySelectorAll('.btn-get-key').forEach((btn) => {
    btn.addEventListener('click', () => window.studioAPI.openExternalUrl(btn.dataset.url));
  });

  grid.querySelectorAll('.btn-del-prov').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.studioAPI.removeProviderKey(btn.dataset.id);
      appendTerm(`\n[Cleared saved key for ${btn.dataset.id}]\n`);
      await refreshProviders();
    });
  });

  grid.querySelectorAll('.model-select-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.studioAPI.setDefaultModel(btn.dataset.model);
      appendTerm(`\n[Active OpenCode model set to ${btn.dataset.model}]\n`);
      await refreshSystemStatus();
    });
  });
}

function showScannedModelsBox(providerId, models = []) {
  const box = document.getElementById('scannedModelsBox');
  const title = document.getElementById('scannedModelsTitle');
  const list = document.getElementById('scannedModelsList');
  if (!box || !list) return;

  box.classList.remove('hidden');
  title.textContent = `DISCOVERED ${models.length} MODELS IN YOUR "${providerId.toUpperCase()}" API KEY (CLICK ANY MODEL TO ACTIVATE):`;
  list.innerHTML = models
    .map(
      (m) =>
        `<button class="chip scanned-model-chip" data-model="${providerId}/${m}" data-info="Click to activate ${providerId}/${m} in OpenCode.">${m}</button>`
    )
    .join('');

  list.querySelectorAll('.scanned-model-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      await window.studioAPI.setDefaultModel(chip.dataset.model);
      appendTerm(`\n[Activated scanned model: ${chip.dataset.model}]\n`);
      await refreshSystemStatus();
    });
  });
}

async function refreshFreeModels() {
  const curatedEl = document.getElementById('curatedModelsTable');
  const liveEl = document.getElementById('liveModelsTable');
  curatedEl.innerHTML = '<div class="muted">Loading ranked free coding models…</div>';
  liveEl.innerHTML = '<div class="muted">Fetching live $0 models from OpenRouter API…</div>';

  const res = await window.studioAPI.fetchFreeCodingModels();
  if (!res) return;

  curatedEl.innerHTML = '';
  for (const m of res.curated || []) {
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `
      <div class="model-rank">#${m.rank}</div>
      <div class="model-main">
        <div class="model-title-line">
          <span class="model-name">${m.name}</span>
          <span class="st-tag-orange">${m.tierLabel}</span>
          <code class="model-id-code" translate="no">${m.id}</code>
          <span class="st-tag">Context: ${m.context}</span>
        </div>
        <div class="model-desc">${m.strengths} — <em>${m.howToUse}</em></div>
      </div>
      <button class="st-btn st-btn-orange use-free-model-btn" data-id="${m.id}" data-info="Set ${m.id} as your active OpenCode coding model.">Use Model</button>
    `;
    curatedEl.appendChild(row);
  }

  liveEl.innerHTML = '';
  if (!res.liveOpenRouter || res.liveOpenRouter.length === 0) {
    liveEl.innerHTML = '<div class="muted">Offline mode — using curated S+ to B free coding tiers above.</div>';
  } else {
    res.liveOpenRouter.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML = `
        <div class="model-rank">${idx + 1}</div>
        <div class="model-main">
          <div class="model-title-line">
            <span class="model-name">${m.name}</span>
            <span class="st-tag-orange">$0 FREE</span>
            <code class="model-id-code" translate="no">${m.id}</code>
            <span class="st-tag">Context: ${m.context}</span>
          </div>
        </div>
        <button class="st-btn st-btn-blue use-free-model-btn" data-id="${m.id}" data-info="Activate live free model ${m.id}.">Use Model</button>
      `;
      liveEl.appendChild(row);
    });
  }

  document.querySelectorAll('.use-free-model-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const modelId = btn.dataset.id;
      await window.studioAPI.setDefaultModel(modelId);
      appendTerm(`\n[Selected free coding model: ${modelId}]\n`);
      await refreshSystemStatus();
    });
  });
}

async function refreshFallbackChain() {
  const fb = await window.studioAPI.getFallbackChain();
  if (!fb) return;
  document.getElementById('chkAutoSwitchFree').checked = fb.enabled !== false;
  document.getElementById('txtFallbackChain').value = (fb.chain || []).join('\n');
  const statusEl = document.getElementById('fallbackLastStatus');
  if (fb.lastStatus && fb.lastStatus.toModel) {
    statusEl.textContent = `Last Auto-Switch: ${fb.lastStatus.fromModel} → ${fb.lastStatus.toModel} (${fb.lastStatus.reason}) at ${fb.lastStatus.lastSwitchAt}`;
  } else {
    statusEl.textContent = `Active Chain Ready (${(fb.chain || []).length} ranked free models). Auto-switches immediately on HTTP 429 / Quota Exhausted.`;
  }
}

async function refreshCloudAccount() {
  const acct = await window.studioAPI.getCloudAccount();
  const topLbl = document.getElementById('cloudTopLabel');
  const topDot = document.getElementById('cloudDot');
  const box = document.getElementById('cloudAccountStatusBox');
  const gistInp = document.getElementById('inpSyncGistId');

  if (acct && acct.signedIn) {
    topDot.classList.add('online');
    topLbl.textContent = `${acct.provider === 'github' ? 'GitHub' : 'Google'}: ${acct.username}`;
    box.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <strong style="color:#5fb878;">Signed in via ${acct.provider.toUpperCase()} as ${acct.displayName} (@${acct.username})</strong>
          <div style="font-size:11px; color:#9d9d9d; margin-top:2px;">
            ${
              acct.gistId
                ? `Secret Gist ID: <code>${acct.gistId}</code>`
                : acct.syncFolder
                ? `Sync Folder: <code>${acct.syncFolder}</code>`
                : 'Ready to push first cloud snapshot'
            }
            ${acct.lastSyncedAt ? ` • Last Synced: ${acct.lastSyncedAt}` : ''}
          </div>
        </div>
      </div>
    `;
    if (acct.gistId && gistInp && !gistInp.value) {
      gistInp.value = acct.gistId;
    }
  } else {
    topDot.classList.remove('online');
    topLbl.textContent = 'Sign In (GitHub / Google)';
    box.textContent = 'Not signed in yet. Sign in with GitHub or Google below to sync your workspace across PCs.';
  }
}

async function refreshBugReports() {
  const reports = (await window.studioAPI.getBugReports()) || [];
  const badge = document.getElementById('bugCountBadge');
  if (badge) badge.textContent = reports.length;

  const list = document.getElementById('bugReportsList');
  if (!list) return;
  list.innerHTML = '';

  if (reports.length === 0) {
    list.innerHTML = '<div class="muted">No runtime bugs or command errors recorded. Everything is running smoothly!</div>';
    return;
  }

  for (const r of reports) {
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `
      <div class="model-main">
        <div class="model-title-line">
          <span class="model-name">${r.title}</span>
          <span class="st-tag">${r.source}</span>
          <span class="st-tag">${r.ts}</span>
        </div>
        <div class="model-desc">${String(r.detail || '').slice(0, 140)}…</div>
      </div>
      <button class="st-btn st-btn-orange btn-send-captured-bug" data-id="${r.id}">Send to GitHub</button>
    `;
    row.querySelector('.btn-send-captured-bug').addEventListener('click', async () => {
      document.getElementById('inpBugTitle').value = r.title;
      document.getElementById('inpBugDesc').value = r.detail;
      await window.studioAPI.reportBugToGitHub({
        title: r.title,
        description: r.detail,
        steps: `Auto-captured from ${r.source} at ${r.ts}`
      });
    });
    list.appendChild(row);
  }
}

window.addEventListener('error', (e) => {
  document.getElementById('inpBugTitle').value = `UI Error: ${e.message}`;
  document.getElementById('inpBugDesc').value = `${e.filename}:${e.lineno}:${e.colno}\n${
    e.error && e.error.stack ? e.error.stack : ''
  }`;
});

async function runStartupCheck(forceShow = false) {
  const modal = document.getElementById('startupModal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');

  if (forceShow) {
    title.textContent = 'Checking for Updates & Required Apps/Drivers…';
    body.innerHTML = '<div>Checking npm registry & local environment…</div>';
    modal.classList.remove('hidden');
  }

  const st = systemState || (await window.studioAPI.getSystemStatus());
  const up = await window.studioAPI.checkUpdates();
  if (!st || !up) return;

  const missingPrereqs = st.prereqs.filter((p) => !p.installed);
  const updateRows = up.items
    .map(
      (i) => `
      <div style="display:flex; justify-content:space-between; padding:6px 10px; background:#1d1d1d; border:1px solid #3d3d3d; border-radius:4px;">
        <span><strong>${i.label}</strong> (<code translate="no">${i.id}</code>)</span>
        <span style="color:${i.hasUpdate ? '#e6a23c' : '#5fb878'}">
          ${i.current} → Latest: ${i.latest} ${i.hasUpdate ? ' (Update Available!)' : ' (Up to date)'}
        </span>
      </div>`
    )
    .join('');

  const missingHtml =
    missingPrereqs.length > 0
      ? `<div style="margin-top:8px; padding:9px; background:rgba(230,162,60,0.12); border:1px solid rgba(230,162,60,0.35); border-radius:4px;">
          <strong style="color:#e6a23c;">Optional / Missing Apps or Drivers Detected (${missingPrereqs.length}):</strong>
          <div style="margin-top:4px;">${missingPrereqs.map((m) => m.name).join(', ')}</div>
        </div>`
      : `<div style="margin-top:8px; color:#5fb878;">All core apps, plugins, skills, and drivers are installed!</div>`;

  title.textContent = up.updatesAvailable
    ? 'Updates Available for Your OpenCode Setup!'
    : 'OpenDocFlow Startup Update & Driver Check';

  body.innerHTML = `
    <div>Would you like to update your OpenCode plugins, REA MCP server, Graphify, or install any missing apps/drivers?</div>
    <div style="display:flex; flex-direction:column; gap:5px; margin-top:6px;">${updateRows}</div>
    ${missingHtml}
  `;
  modal.classList.remove('hidden');
}

// Event Listeners
document.getElementById('btnCloudTopPill').addEventListener('click', () => switchTab('cloud'));
document.getElementById('btnQuickScanKeyJump').addEventListener('click', () => switchTab('keys'));
document.getElementById('btnCheckUpdatesTop').addEventListener('click', () => runStartupCheck(true));
document.getElementById('btnCloseModal').addEventListener('click', () => {
  document.getElementById('startupModal').classList.add('hidden');
});
document.getElementById('btnModalLater').addEventListener('click', () => {
  document.getElementById('startupModal').classList.add('hidden');
});
document.getElementById('btnModalPrereqs').addEventListener('click', () => {
  document.getElementById('startupModal').classList.add('hidden');
  switchTab('prereqs');
});
document.getElementById('btnModalUpdateNow').addEventListener('click', async () => {
  document.getElementById('startupModal').classList.add('hidden');
  appendTerm('\n=== Running Full Component Updates ===\n');
  await window.studioAPI.updateAllComponents();
  await refreshSystemStatus();
});

document.getElementById('btnConnectGatewayQuick').addEventListener('click', async () => {
  const res = await window.studioAPI.connectLocalGatewayToOpenCode();
  appendTerm(`\n[Connected OpenCode V2 to Smart Local Gateway: ${res.endpoint} (${res.model})]\n`);
  await refreshSystemStatus();
  await refreshGatewayTelemetry();
});

document.getElementById('btnConnectAllIdes').addEventListener('click', async () => {
  const res = await window.studioAPI.connectAllIdesToGateway();
  appendTerm(`\n[Configured All IDEs to Smart Gateway (:4141/v1) -> ${res.scriptPath}]\n`);
  await refreshSystemStatus();
  await refreshGatewayTelemetry();
});

document.getElementById('btnRotateNextFreeSidebar').addEventListener('click', async () => {
  const res = await window.studioAPI.triggerNextFreeModelNow();
  appendTerm(`\n[Auto-Switched Free Model: ${res.fromModel} -> ${res.toModel}]\n`);
  await refreshSystemStatus();
  await refreshFallbackChain();
});

document.getElementById('btnQuickReportBug').addEventListener('click', () => switchTab('bugs'));

document.getElementById('btnQuickUpdateAll').addEventListener('click', async () => {
  appendTerm('\n=== Updating All Plugins, REA & Graphify ===\n');
  await window.studioAPI.updateAllComponents();
  await refreshSystemStatus();
});

document.getElementById('btnQuickPrereqModal').addEventListener('click', () => switchTab('prereqs'));

document.getElementById('btnRestoreAllTop').addEventListener('click', async () => {
  appendTerm('\n=== Restoring All Portable Settings, Plugins, Skills & REA ===\n');
  await window.studioAPI.runFullKitRestore();
  await refreshSystemStatus();
});

document.getElementById('btnSnapshotKitTop').addEventListener('click', async () => {
  appendTerm('\n=== Saving Current Config, Plugins & Skills into Portable Kit ===\n');
  await window.studioAPI.updatePortableKit();
});

document.getElementById('btnSelectMissingPrereqs').addEventListener('click', () => {
  if (!systemState) return;
  document.querySelectorAll('.prereq-check').forEach((chk) => {
    const found = systemState.prereqs.find((p) => p.id === chk.dataset.id);
    chk.checked = found ? !found.installed : false;
  });
});

document.getElementById('btnInstallSelectedPrereqs').addEventListener('click', async () => {
  const selected = Array.from(document.querySelectorAll('.prereq-check:checked')).map((c) => c.dataset.id);
  if (selected.length === 0) {
    appendTerm('\n[No apps/drivers selected to install.]\n');
    return;
  }
  appendTerm(`\n=== Installing Selected Apps & Drivers: ${selected.join(', ')} ===\n`);
  await window.studioAPI.installPrerequisites(selected);
  await refreshSystemStatus();
});

document.getElementById('btnSaveQuickModel').addEventListener('click', async () => {
  const val = document.getElementById('inpQuickModel').value.trim();
  if (!val) return;
  await window.studioAPI.setDefaultModel(val);
  appendTerm(`\n[Set active model to ${val}]\n`);
  await refreshSystemStatus();
});

document.querySelectorAll('.chip[data-model]').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const m = chip.dataset.model;
    document.getElementById('inpQuickModel').value = m;
    await window.studioAPI.setDefaultModel(m);
    appendTerm(`\n[Set active model to ${m}]\n`);
    await refreshSystemStatus();
  });
});

document.getElementById('btnScanCustomKeyModels').addEventListener('click', async () => {
  const id = document.getElementById('custProviderId').value.trim() || 'openrouter';
  const apiKey = document.getElementById('custApiKey').value.trim();
  const baseURL = document.getElementById('custBaseUrl').value.trim();
  appendTerm(`\n[Scanning models unlocked by your ${id} API key…]\n`);
  const res = await window.studioAPI.discoverModelsFromKey({ id, apiKey, baseURL });
  if (res.ok && res.models && res.models.length > 0) {
    appendTerm(`\n[Success! Read ${res.count} models from your ${id} API key]\n`);
    showScannedModelsBox(res.providerId, res.models);
    await refreshProviders();
  } else {
    appendTerm(`\n[Could not read models from key: ${res.error || 'Check key or endpoint'}]\n`);
  }
});

document.getElementById('btnAddCustomModel').addEventListener('click', async () => {
  const providerId = document.getElementById('custProviderId').value.trim();
  const modelId = document.getElementById('custModelId').value.trim();
  if (!providerId || !modelId) {
    appendTerm('\n[Enter both Provider ID and Model ID, or click "Scan & Read All Models in My API Key" first.]\n');
    return;
  }
  const res = await window.studioAPI.addCustomModel({
    providerId,
    modelId,
    displayName: document.getElementById('custDisplayName').value.trim(),
    baseURL: document.getElementById('custBaseUrl').value.trim(),
    apiKey: document.getElementById('custApiKey').value.trim(),
    setAsDefault: true
  });
  appendTerm(`\n[Added & activated custom model: ${res.fullRef}]\n`);
  await refreshProviders();
  await refreshSystemStatus();
});

document.getElementById('btnRefreshFreeModels').addEventListener('click', refreshFreeModels);

document.getElementById('btnSaveFallbackChain').addEventListener('click', async () => {
  const enabled = document.getElementById('chkAutoSwitchFree').checked;
  const lines = document
    .getElementById('txtFallbackChain')
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  await window.studioAPI.saveFallbackChain({ enabled, chain: lines });
  appendTerm(`\n[Saved Auto-Fallback Free Model Chain (${lines.length} models, enabled=${enabled})]\n`);
  await refreshFallbackChain();
});

document.getElementById('btnRotateNextFreeNow').addEventListener('click', async () => {
  const res = await window.studioAPI.triggerNextFreeModelNow();
  appendTerm(`\n[Auto-Switched Free Model: ${res.fromModel} -> ${res.toModel}]\n`);
  await refreshSystemStatus();
  await refreshFallbackChain();
});

// Universal World Skill & Plugin Harvester Listeners
document.getElementById('btnImportUniversalSkill').addEventListener('click', async () => {
  const source = document.getElementById('inpUniSkillSource').value.trim();
  const skillName = document.getElementById('inpUniSkillName').value.trim();
  const rawContent = document.getElementById('txtUniSkillRaw').value.trim();
  const res = await window.studioAPI.importUniversalSkill({
    source,
    skillName,
    rawContent,
    syncAllAgents: true
  });
  if (res.ok) {
    appendTerm(`\n[Successfully imported Universal Skill: ${res.skillId}]\n`);
    document.getElementById('txtUniSkillRaw').value = '';
    await refreshSystemStatus();
  } else {
    appendTerm(`\n[Skill import note: ${res.error}]\n`);
  }
});

document.getElementById('btnSyncAllAgentSkills').addEventListener('click', async () => {
  await window.studioAPI.syncAllAgentsSkills();
  await refreshSystemStatus();
});

document.querySelectorAll('.world-pack-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const pack = btn.dataset.pack;
    document.getElementById('inpUniSkillSource').value = pack;
    await window.studioAPI.importUniversalSkill({ source: pack, syncAllAgents: true });
    await refreshSystemStatus();
  });
});

document.getElementById('btnInstallUniversalPlugin').addEventListener('click', async () => {
  const spec = document.getElementById('inpUniversalPlugin').value.trim();
  if (!spec) return;
  await window.studioAPI.installUniversalPlugin({ spec, wrapV2: true });
  await refreshSystemStatus();
});

document.getElementById('btnBulkImportSkills').addEventListener('click', async () => {
  const urlsText = document.getElementById('txtBulkSkillUrls').value.trim();
  if (!urlsText) return;
  appendTerm('\n[Bulk importing multiple skill URLs…]\n');
  const res = await window.studioAPI.bulkImportSkillUrls(urlsText);
  if (res.ok) {
    document.getElementById('txtBulkSkillUrls').value = '';
    await refreshSystemStatus();
  }
});

document.getElementById('btnSaveEditedSkill').addEventListener('click', async () => {
  if (!currentlyEditingSkill) {
    appendTerm('\n[Click any skill pill above first to load its SKILL.md into the editor.]\n');
    return;
  }
  const content = document.getElementById('txtSkillFileEditor').value;
  await window.studioAPI.saveSkillOrPluginFile({
    kind: 'skill',
    name: currentlyEditingSkill,
    content
  });
  appendTerm(`\n[Saved changes to ${currentlyEditingSkill}/SKILL.md]\n`);
});

// MCP Manager, Custom Agents, Slash Commands & Raw Config Studio
async function refreshMcpAndAgentsStudio() {
  const [mcps, agCmds, rawCfg] = await Promise.all([
    window.studioAPI.getMcpServers(),
    window.studioAPI.getAgentsAndCommands(),
    window.studioAPI.getRawConfigs()
  ]);

  const mcpList = document.getElementById('mcpServersList');
  if (mcpList) {
    mcpList.innerHTML = '';
    for (const m of mcps || []) {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML = `
        <div class="model-main">
          <div class="model-title-line">
            <span class="model-name">${m.name}</span>
            <span class="st-tag">${m.type}</span>
            <span class="status-badge ${m.enabled ? 'ok' : 'missing'}">${m.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div class="model-desc"><code translate="no">${m.command}</code></div>
        </div>
        <div class="btn-row">
          <button class="st-btn ${m.enabled ? 'st-btn-default' : 'st-btn-blue'} btn-toggle-mcp" data-name="${m.name}" data-enabled="${!m.enabled}">
            ${m.enabled ? 'Disable' : 'Enable'}
          </button>
          <button class="st-btn st-btn-danger btn-del-mcp" data-name="${m.name}">Delete</button>
        </div>
      `;
      row.querySelector('.btn-toggle-mcp').addEventListener('click', async (e) => {
        await window.studioAPI.toggleMcpServer({
          name: e.currentTarget.dataset.name,
          enabled: e.currentTarget.dataset.enabled === 'true'
        });
        await refreshMcpAndAgentsStudio();
        await refreshSystemStatus();
      });
      row.querySelector('.btn-del-mcp').addEventListener('click', async (e) => {
        await window.studioAPI.removeMcpServer(e.currentTarget.dataset.name);
        await refreshMcpAndAgentsStudio();
        await refreshSystemStatus();
      });
      mcpList.appendChild(row);
    }
  }

  const acList = document.getElementById('agentsCommandsList');
  if (acList && agCmds) {
    acList.innerHTML = '';
    for (const a of agCmds.agents || []) {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML = `
        <div class="model-main">
          <div class="model-title-line">
            <span class="model-name">Agent: @${a.id}</span>
            <span class="st-tag-orange">${a.mode}</span>
            ${a.model ? `<code class="model-id-code">${a.model}</code>` : ''}
          </div>
          <div class="model-desc">${a.system || a.description}</div>
        </div>
        <button class="st-btn st-btn-danger btn-del-agent" data-id="${a.id}">Delete</button>
      `;
      row.querySelector('.btn-del-agent').addEventListener('click', async () => {
        await window.studioAPI.deleteCustomAgent(a.id);
        await refreshMcpAndAgentsStudio();
      });
      acList.appendChild(row);
    }
    for (const c of agCmds.commands || []) {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML = `
        <div class="model-main">
          <div class="model-title-line">
            <span class="model-name">Command: /${c.id}</span>
            <span class="st-tag">Slash Command</span>
          </div>
          <div class="model-desc">${c.template}</div>
        </div>
        <button class="st-btn st-btn-danger btn-del-cmd" data-id="${c.id}">Delete</button>
      `;
      row.querySelector('.btn-del-cmd').addEventListener('click', async () => {
        await window.studioAPI.deleteCustomCommand(c.id);
        await refreshMcpAndAgentsStudio();
      });
      acList.appendChild(row);
    }
  }

  if (rawCfg) {
    document.getElementById('txtRawOpencode').value = rawCfg.opencodeJsonc || '';
    document.getElementById('txtRawCli').value = rawCfg.cliJson || '';
    document.getElementById('txtRawAgentsMd').value = rawCfg.agentsMd || '';
  }
}

document.getElementById('btnAddMcpServer').addEventListener('click', async () => {
  const name = document.getElementById('inpMcpName').value.trim();
  const commandOrUrl = document.getElementById('inpMcpCmd').value.trim();
  if (!name || !commandOrUrl) return;
  await window.studioAPI.addMcpServer({ name, commandOrUrl });
  document.getElementById('inpMcpName').value = '';
  document.getElementById('inpMcpCmd').value = '';
  appendTerm(`\n[Added MCP Server: ${name}]\n`);
  await refreshMcpAndAgentsStudio();
  await refreshSystemStatus();
});

document.getElementById('btnSaveCustomAgent').addEventListener('click', async () => {
  const id = document.getElementById('inpAgentId').value.trim();
  const model = document.getElementById('inpAgentModel').value.trim();
  const system = document.getElementById('inpAgentSystem').value.trim();
  const readOnly = document.getElementById('chkAgentReadOnly').checked;
  if (!id) return;
  await window.studioAPI.saveCustomAgent({ id, model, system, readOnly, mode: 'subagent' });
  appendTerm(`\n[Saved Custom Agent @${id}]\n`);
  await refreshMcpAndAgentsStudio();
});

document.getElementById('btnSaveCustomCommand').addEventListener('click', async () => {
  const id = document.getElementById('inpCmdId').value.trim();
  const template = document.getElementById('inpCmdTemplate').value.trim();
  if (!id || !template) return;
  await window.studioAPI.saveCustomCommand({ id, template });
  appendTerm(`\n[Saved Custom Slash Command /${id}]\n`);
  await refreshMcpAndAgentsStudio();
});

document.getElementById('btnSaveRawConfigs').addEventListener('click', async () => {
  await window.studioAPI.saveRawConfigs({
    opencodeJsonc: document.getElementById('txtRawOpencode').value,
    cliJson: document.getElementById('txtRawCli').value,
    agentsMd: document.getElementById('txtRawAgentsMd').value
  });
  appendTerm('\n[Saved opencode.jsonc, cli.json, and AGENTS.md]\n');
  await refreshSystemStatus();
});

async function refreshProfilesList() {
  const profiles = (await window.studioAPI.getProfiles()) || [];
  const wrap = document.getElementById('profilesListPills');
  if (!wrap) return;
  wrap.innerHTML = profiles
    .map(
      (p) =>
        `<button class="chip profile-switch-chip" data-name="${p}" data-info="Click to switch your active OpenCode environment to profile '${p}'.">Switch: ${p}</button>`
    )
    .join('');
  wrap.querySelectorAll('.profile-switch-chip').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.studioAPI.switchProfile(btn.dataset.name);
      appendTerm(`\n[Switched active OpenCode Profile to: ${btn.dataset.name}]\n`);
      await Promise.all([refreshSystemStatus(), refreshFallbackChain(), refreshMcpAndAgentsStudio()]);
    });
  });
}

document.getElementById('btnSaveProfileNow').addEventListener('click', async () => {
  const name = document.getElementById('inpProfileName').value.trim();
  if (!name) return;
  await window.studioAPI.saveProfileSnapshot(name);
  document.getElementById('inpProfileName').value = '';
  appendTerm(`\n[Saved isolated OpenCode Profile: ${name}]\n`);
  await refreshProfilesList();
});

// Cloud Sign-In & Sync Listeners
document.getElementById('btnSignInGitHub').addEventListener('click', async () => {
  const token = document.getElementById('inpCloudGithubToken').value.trim();
  const res = await window.studioAPI.signInCloud({ provider: 'github', token });
  if (res.ok) {
    appendTerm(`\n[Signed in with GitHub as @${res.account.username}]\n`);
    await refreshCloudAccount();
  } else {
    appendTerm(`\n[GitHub Sign-In: ${res.message || res.error}]\n`);
  }
});

document.getElementById('btnSignInGoogle').addEventListener('click', async () => {
  const email = document.getElementById('inpCloudGoogleEmail').value.trim() || 'Google Drive User';
  const res = await window.studioAPI.signInCloud({ provider: 'google', email });
  if (res.ok) {
    appendTerm(`\n[Signed in with Google Cloud Sync (${res.account.syncFolder})]\n`);
    await refreshCloudAccount();
  }
});

document.getElementById('btnSignOutCloud').addEventListener('click', async () => {
  await window.studioAPI.signOutCloud();
  appendTerm('\n[Signed out of Cloud Sync]\n');
  await refreshCloudAccount();
});

document.getElementById('btnPushCloudSync').addEventListener('click', async () => {
  const passphrase = document.getElementById('inpSyncPassphrase').value.trim();
  appendTerm('\n[Uploading encrypted workspace snapshot to Cloud…]\n');
  const res = await window.studioAPI.pushCloudSync({ passphrase });
  if (res.ok) {
    if (res.gistId) document.getElementById('inpSyncGistId').value = res.gistId;
    appendTerm(`\n[Cloud Sync Saved! ${res.url || res.filePath}]\n`);
    await refreshCloudAccount();
  } else {
    appendTerm(`\n[Cloud Sync error: ${res.error}]\n`);
  }
});

document.getElementById('btnPullCloudSync').addEventListener('click', async () => {
  const passphrase = document.getElementById('inpSyncPassphrase').value.trim();
  const gistId = document.getElementById('inpSyncGistId').value.trim();
  appendTerm('\n[Restoring workspace snapshot from Cloud…]\n');
  const res = await window.studioAPI.pullCloudSync({ passphrase, gistId });
  if (res.ok) {
    appendTerm('\n[Workspace restored from Cloud!]\n');
    await Promise.all([
      refreshSystemStatus(),
      refreshProviders(),
      refreshFallbackChain(),
      refreshCloudAccount(),
      loadSavedNodePositions()
    ]);
  } else {
    appendTerm(`\n[Cloud Restore error: ${res.error}]\n`);
  }
});

document.getElementById('btnPickProjectDir').addEventListener('click', async () => {
  const dir = await window.studioAPI.pickDirectory();
  if (dir) document.getElementById('inpProjectPath').value = dir;
});

document.getElementById('btnCreateProjectNow').addEventListener('click', async () => {
  const p = document.getElementById('inpProjectPath').value.trim();
  const q = document.getElementById('inpProjectSkill').value.trim();
  if (!p) {
    appendTerm('\n[Please enter or browse a Project Folder Path first.]\n');
    return;
  }
  await window.studioAPI.createNewProject({ path: p, skillQuery: q });
  await refreshSystemStatus();
});

document.getElementById('btnOpenProjectTerminal').addEventListener('click', async () => {
  const p = document.getElementById('inpProjectPath').value.trim();
  await window.studioAPI.openExternalTerminal(p || undefined, 'opencode');
});

document.getElementById('btnSearchSkillNow').addEventListener('click', async () => {
  const q = document.getElementById('inpSkillSearch').value.trim();
  if (!q) return;
  await window.studioAPI.searchSkills(q);
});

document.getElementById('btnInstallSkillNow').addEventListener('click', async () => {
  const spec = document.getElementById('inpSkillInstall').value.trim();
  if (!spec) return;
  await window.studioAPI.installSkill(spec);
  await refreshSystemStatus();
});

document.getElementById('btnOpenConfigFolder').addEventListener('click', () => {
  if (systemState && systemState.configDir) {
    window.studioAPI.openPath(systemState.configDir);
  }
});

// Inspector controls
document.getElementById('selGatewayStrategy').addEventListener('change', async (e) => {
  await window.studioAPI.updateGatewaySettings({ strategy: e.target.value });
  await refreshGatewayTelemetry();
});

document.getElementById('chkTokenCompress').addEventListener('change', async (e) => {
  await window.studioAPI.updateGatewaySettings({ compressionEnabled: e.target.checked });
  await refreshGatewayTelemetry();
});

document.getElementById('chkPromptCache').addEventListener('change', async (e) => {
  await window.studioAPI.updateGatewaySettings({ promptCacheEnabled: e.target.checked });
  await refreshGatewayTelemetry();
});

document.getElementById('chkAutoBugCapture').addEventListener('change', async (e) => {
  await window.studioAPI.updateGatewaySettings({ autoBugReport: e.target.checked });
});

document.getElementById('btnClearCacheSmall').addEventListener('click', async () => {
  await window.studioAPI.clearPromptCache();
  await refreshGatewayTelemetry();
});

document.getElementById('btnOpenGitHubRepo').addEventListener('click', () => {
  window.studioAPI.openExternalUrl('https://github.com/vaasiraq-art/OpenDocFlow');
});

// Bug Reporter controls
document.getElementById('btnSubmitGitHubIssue').addEventListener('click', async () => {
  const title = document.getElementById('inpBugTitle').value.trim() || 'Bug Report from OpenDocFlow v3.1';
  const description = document.getElementById('inpBugDesc').value.trim();
  const steps = document.getElementById('inpBugSteps').value.trim();
  const res = await window.studioAPI.reportBugToGitHub({ title, description, steps });
  appendTerm(`\n[Submitted Issue to GitHub (${res.method}): ${res.url}]\n`);
});

document.getElementById('btnOpenRepoIssuesPage').addEventListener('click', () => {
  window.studioAPI.openExternalUrl('https://github.com/vaasiraq-art/OpenDocFlow/issues');
});

document.getElementById('btnClearBugLogs').addEventListener('click', async () => {
  await window.studioAPI.clearBugReports();
  await refreshBugReports();
});

document.getElementById('btnLaunchOpenCode').addEventListener('click', () => {
  window.studioAPI.openExternalTerminal(undefined, 'opencode');
});

document.getElementById('btnPopoutTerminal').addEventListener('click', () => {
  window.studioAPI.openExternalTerminal(undefined, 'opencode');
});

document.getElementById('btnCreateShortcut').addEventListener('click', async () => {
  const res = await window.studioAPI.createDesktopShortcut();
  appendTerm(res.ok ? `\n[Created Desktop Icon: ${res.shortcutPath}]\n` : '\n[Could not create shortcut]\n');
});

// Terminal Dock Controls
async function sendTerminalInput() {
  const inp = document.getElementById('terminalInput');
  const cmd = inp.value.trim();
  if (!cmd) return;
  inp.value = '';
  await window.studioAPI.runTerminalCommand(cmd);
}

document.getElementById('btnSendTermCmd').addEventListener('click', sendTerminalInput);
document.getElementById('terminalInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTerminalInput();
});

document.querySelectorAll('.cmd-preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    window.studioAPI.runTerminalCommand(btn.dataset.cmd);
  });
});

document.getElementById('btnStopTermCmd').addEventListener('click', () => {
  window.studioAPI.stopTerminalCommand();
});

document.getElementById('btnClearTerm').addEventListener('click', () => {
  document.getElementById('terminalOutput').textContent = '';
});

document.getElementById('btnToggleDock').addEventListener('click', () => {
  const dock = document.getElementById('terminalDock');
  dock.classList.toggle('expanded');
});

// Initialize on load: instant local render (<5ms), non-blocking background checks
(async function init() {
  initDraggableNodes();
  await Promise.all([
    refreshSystemStatus(),
    refreshProviders(),
    refreshFallbackChain(),
    refreshGatewayTelemetry(),
    refreshCloudAccount(),
    refreshBugReports(),
    refreshMcpAndAgentsStudio(),
    refreshProfilesList(),
    loadSavedNodePositions()
  ]);
  refreshFreeModels();
  setTimeout(() => runStartupCheck(false), 500);
  setInterval(refreshGatewayTelemetry, 4000);
})();
