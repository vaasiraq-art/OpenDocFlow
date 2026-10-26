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

const TAB_TITLES = {
  dashboard: '3D / Node Viewport — Studio Layout',
  router: 'Shader Node Editor — AI Routing Combos & Auto-Failover',
  keys: 'Provider Credentials — Free, Paid, Local & Custom Gateways',
  'free-models': 'Ranked Free Coding Models — Best (S+) to Low',
  skills: 'Universal World Skill & Plugin Harvester (Claude, Codex, Cursor, Web)',
  prereqs: 'System & Device Drivers Wizard (OpenCode, Node, ADB, REA, Graphify)',
  bugs: 'Auto Bug Catcher & 1-Click GitHub Issue Reporter',
  'terminal-tab': 'Scripting & CLI Presets'
};

function switchTab(tabId) {
  document.querySelectorAll('.bl-ws-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });
  const headerLbl = document.getElementById('viewportHeaderLabel');
  if (headerLbl) headerLbl.textContent = TAB_TITLES[tabId] || 'Studio Viewport';
}

document.querySelectorAll('.bl-ws-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

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
      const s = document.createElement('span');
      s.className = 'pill';
      s.textContent = sk;
      sWrap.appendChild(s);
    });
  }
}

async function refreshGatewayTelemetry() {
  const gw = await window.studioAPI.getGatewayTelemetry();
  if (!gw) return;

  document.getElementById('inspReqCount').textContent = gw.requestsTotal;
  document.getElementById('inspFailovers').textContent = gw.failoversSaved;
  document.getElementById('inspTokensSaved').textContent = gw.tokensSaved;
  document.getElementById('nodeTokensSaved').textContent = gw.tokensSaved;
  document.getElementById('nodeFailoversCount').textContent = gw.failoversSaved;
  document.getElementById('nodeStrategyLabel').textContent = gw.strategy;
  document.getElementById('selGatewayStrategy').value = gw.strategy;
  document.getElementById('chkTokenCompress').checked = gw.compressionEnabled;
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
      .map((m) => `<button class="chip model-select-btn" data-model="${p.id}/${m}">${m}</button>`)
      .join('');

    card.innerHTML = `
      <div class="provider-top">
        <div>
          <div class="provider-name">${p.name}</div>
          <div class="provider-tier">${p.tier} • <code translate="no">${p.id}</code></div>
        </div>
        <span class="status-badge ${p.hasKey || p.localNoKey ? 'ok' : 'missing'}">
          ${p.localNoKey ? 'Local Ready' : p.hasKey ? 'Key Saved' : 'No Key'}
        </span>
      </div>
      <div class="form-row" style="margin-bottom:4px;">
        <label>${p.localNoKey ? 'Optional Bearer Key' : `API Key (${p.envKey})`}</label>
        <input type="password" class="prov-key-inp" data-id="${p.id}" autocomplete="off" placeholder="${p.hasKey ? '•••••••••••••••• (Saved)' : 'Paste API key…'}" />
      </div>
      <div class="form-row" style="margin-bottom:4px;">
        <label>Endpoint Base URL</label>
        <input type="url" class="prov-url-inp" data-id="${p.id}" autocomplete="off" spellcheck="false" value="${p.baseURL || ''}" placeholder="Default Official Endpoint…" />
      </div>
      <div class="quick-chips">${modelOptions}</div>
      <div class="btn-row" style="margin-top:auto; padding-top:4px;">
        <button class="bl-btn bl-btn-orange btn-save-prov" data-id="${p.id}" data-name="${p.name}" data-env="${p.envKey}" data-builtin="${p.builtin}">
          Save Key
        </button>
        ${p.keyUrl ? `<button class="bl-btn bl-btn-default btn-get-key" data-url="${p.keyUrl}">Get Key</button>` : ''}
        ${p.hasKey ? `<button class="bl-btn bl-btn-danger btn-del-prov" data-id="${p.id}">Clear</button>` : ''}
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
          <span class="bl-tag-orange">${m.tierLabel}</span>
          <code class="model-id-code" translate="no">${m.id}</code>
          <span class="bl-tag">Context: ${m.context}</span>
        </div>
        <div class="model-desc">${m.strengths} — <em>${m.howToUse}</em></div>
      </div>
      <button class="bl-btn bl-btn-orange use-free-model-btn" data-id="${m.id}">Use Model</button>
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
            <span class="bl-tag-orange">$0 FREE</span>
            <code class="model-id-code" translate="no">${m.id}</code>
            <span class="bl-tag">Context: ${m.context}</span>
          </div>
        </div>
        <button class="bl-btn bl-btn-blue use-free-model-btn" data-id="${m.id}">Use Model</button>
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
          <span class="bl-tag">${r.source}</span>
          <span class="bl-tag">${r.ts}</span>
        </div>
        <div class="model-desc">${String(r.detail || '').slice(0, 140)}…</div>
      </div>
      <button class="bl-btn bl-btn-orange btn-send-captured-bug" data-id="${r.id}">Send to GitHub</button>
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

// Catch any renderer-side error and feed into Auto-Bug Reporter
window.addEventListener('error', (e) => {
  document.getElementById('inpBugTitle').value = `UI Error: ${e.message}`;
  document.getElementById('inpBugDesc').value = `${e.filename}:${e.lineno}:${e.colno}\n${e.error && e.error.stack ? e.error.stack : ''}`;
});

// Startup modal: checks updates & missing apps/drivers on launch without blocking UI
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
    : 'OpenCode Studio Startup Update & Driver Check';

  body.innerHTML = `
    <div>Would you like to update your OpenCode plugins, REA MCP server, Graphify, or install any missing apps/drivers?</div>
    <div style="display:flex; flex-direction:column; gap:5px; margin-top:6px;">${updateRows}</div>
    ${missingHtml}
  `;
  modal.classList.remove('hidden');
}

// Event Listeners
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

document.getElementById('btnAddCustomModel').addEventListener('click', async () => {
  const providerId = document.getElementById('custProviderId').value.trim();
  const modelId = document.getElementById('custModelId').value.trim();
  if (!providerId || !modelId) {
    appendTerm('\n[Please enter both Provider ID and Model ID.]\n');
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

document.getElementById('chkAutoBugCapture').addEventListener('change', async (e) => {
  await window.studioAPI.updateGatewaySettings({ autoBugReport: e.target.checked });
});

document.getElementById('btnOpenGitHubRepo').addEventListener('click', () => {
  window.studioAPI.openExternalUrl('https://github.com/vaasiraq-art/opencode-studio');
});

// Bug Reporter controls
document.getElementById('btnSubmitGitHubIssue').addEventListener('click', async () => {
  const title = document.getElementById('inpBugTitle').value.trim() || 'Bug Report from OpenCode Studio v2.0';
  const description = document.getElementById('inpBugDesc').value.trim();
  const steps = document.getElementById('inpBugSteps').value.trim();
  const res = await window.studioAPI.reportBugToGitHub({ title, description, steps });
  appendTerm(`\n[Submitted Issue to GitHub (${res.method}): ${res.url}]\n`);
});

document.getElementById('btnOpenRepoIssuesPage').addEventListener('click', () => {
  window.studioAPI.openExternalUrl('https://github.com/vaasiraq-art/opencode-studio/issues');
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
  await Promise.all([
    refreshSystemStatus(),
    refreshProviders(),
    refreshFallbackChain(),
    refreshGatewayTelemetry(),
    refreshBugReports()
  ]);
  refreshFreeModels();
  setTimeout(() => runStartupCheck(false), 500);
  setInterval(refreshGatewayTelemetry, 4000);
})();
