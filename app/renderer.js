let systemState = null;

function appendTerm(text) {
  const out = document.getElementById('terminalOutput');
  if (!out) return;
  const clean = String(text).replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  out.textContent += clean;
  out.scrollTop = out.scrollHeight;
}

window.studioAPI.onTerminalData((msg) => {
  appendTerm(msg.text);
});

function switchTab(tabId) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

async function refreshSystemStatus() {
  const st = await window.studioAPI.getSystemStatus();
  systemState = st;

  document.getElementById('sidebarActiveModel').textContent = st.currentModel;
  document.getElementById('inpQuickModel').value = st.currentModel === 'Default (Provider Default)' ? '' : st.currentModel;

  const oc = st.prereqs.find((p) => p.id === 'opencode');
  document.getElementById('statOpenCode').textContent = oc && oc.installed ? oc.version : 'Missing';
  document.getElementById('statPlugins').textContent = st.plugins.length;
  document.getElementById('statSkills').textContent = st.skills.length;
  document.getElementById('statMcp').textContent = st.mcpServers.length;

  renderPrereqs(st.prereqs);
  renderPills(st.plugins, st.mcpServers, st.skills);
}

function renderPrereqs(prereqs = []) {
  const container = document.getElementById('prereqsList');
  container.innerHTML = '';
  for (const item of prereqs) {
    const div = document.createElement('div');
    div.className = 'prereq-item';
    div.innerHTML = `
      <input type="checkbox" class="prereq-check" data-id="${item.id}" ${!item.installed ? 'checked' : ''} />
      <div class="prereq-info">
        <div class="prereq-title">
          <span>${item.name}</span>
          <span class="status-badge ${item.installed ? 'ok' : 'missing'}">
            ${item.installed ? 'Installed' : 'Needs Install'}
          </span>
        </div>
        <div style="font-size:11.5px; color:#89ddff; margin: 3px 0;">${item.category} • ${item.version}</div>
        <div style="font-size:12px; color:#939bb8;">${item.description}</div>
      </div>
    `;
    container.appendChild(div);
  }
}

function renderPills(plugins = [], mcps = [], skills = []) {
  const pWrap = document.getElementById('pillsPlugins');
  pWrap.innerHTML = '';
  [...plugins.map((p) => `Plugin: ${p}`), ...mcps.map((m) => `MCP: ${m}`)].forEach((label) => {
    const s = document.createElement('span');
    s.className = 'pill';
    s.textContent = label;
    pWrap.appendChild(s);
  });

  const sWrap = document.getElementById('pillsSkills');
  sWrap.innerHTML = '';
  skills.forEach((sk) => {
    const s = document.createElement('span');
    s.className = 'pill';
    s.textContent = sk;
    sWrap.appendChild(s);
  });
}

async function refreshProviders() {
  const data = await window.studioAPI.getProvidersState();
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
          <div class="provider-tier">${p.tier} • <code>${p.id}</code></div>
        </div>
        <span class="status-badge ${p.hasKey || p.localNoKey ? 'ok' : 'missing'}">
          ${p.localNoKey ? 'Local Ready' : p.hasKey ? 'Key Saved' : 'No Key'}
        </span>
      </div>
      <div class="form-row" style="margin-bottom:4px;">
        <label>${p.localNoKey ? 'Optional Bearer Key' : `API Key (${p.envKey})`}</label>
        <input type="password" class="prov-key-inp" data-id="${p.id}" placeholder="${p.hasKey ? '•••••••••••••••• (Saved)' : 'Paste API key...'}" />
      </div>
      <div class="form-row" style="margin-bottom:4px;">
        <label>Endpoint Base URL</label>
        <input type="text" class="prov-url-inp" data-id="${p.id}" value="${p.baseURL || ''}" placeholder="Default Official Endpoint" />
      </div>
      <div class="quick-chips">${modelOptions}</div>
      <div class="btn-row" style="margin-top:auto; padding-top:6px;">
        <button class="btn btn-sm btn-primary btn-save-prov" data-id="${p.id}" data-name="${p.name}" data-env="${p.envKey}" data-builtin="${p.builtin}">
          Save Key
        </button>
        ${p.keyUrl ? `<button class="btn btn-sm btn-outline btn-get-key" data-url="${p.keyUrl}">Get Key</button>` : ''}
        ${p.hasKey ? `<button class="btn btn-sm btn-danger btn-del-prov" data-id="${p.id}">Clear</button>` : ''}
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
      appendTerm(`\n[Removed saved key for ${btn.dataset.id}]\n`);
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
  curatedEl.innerHTML = '<div class="muted">Loading ranked free coding models...</div>';
  liveEl.innerHTML = '<div class="muted">Fetching live $0 models from OpenRouter API...</div>';

  const res = await window.studioAPI.fetchFreeCodingModels();

  curatedEl.innerHTML = '';
  for (const m of res.curated || []) {
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `
      <div class="model-rank">#${m.rank}</div>
      <div class="model-main">
        <div class="model-title-line">
          <span class="model-name">${m.name}</span>
          <span class="tag tag-green">${m.tierLabel}</span>
          <code class="model-id-code">${m.id}</code>
          <span class="tag">Context: ${m.context}</span>
        </div>
        <div class="model-desc">${m.strengths} — <em>${m.howToUse}</em></div>
      </div>
      <button class="btn btn-sm btn-primary use-free-model-btn" data-id="${m.id}">Use Model</button>
    `;
    curatedEl.appendChild(row);
  }

  liveEl.innerHTML = '';
  if (!res.liveOpenRouter || res.liveOpenRouter.length === 0) {
    liveEl.innerHTML = '<div class="muted">Could not reach OpenRouter live catalog (offline). Curated list above is ready.</div>';
  } else {
    res.liveOpenRouter.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML = `
        <div class="model-rank">${idx + 1}</div>
        <div class="model-main">
          <div class="model-title-line">
            <span class="model-name">${m.name}</span>
            <span class="tag tag-purple">$0 FREE</span>
            <code class="model-id-code">${m.id}</code>
            <span class="tag">Context: ${m.context}</span>
          </div>
        </div>
        <button class="btn btn-sm btn-accent use-free-model-btn" data-id="${m.id}">Use Model</button>
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

// Startup modal: checks updates & missing apps/drivers on launch without blocking UI
async function runStartupCheck(forceShow = false) {
  const modal = document.getElementById('startupModal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');

  if (forceShow) {
    title.textContent = 'Checking for Updates & Required Apps/Drivers...';
    body.innerHTML = '<div>Checking npm registry & local environment...</div>';
    modal.classList.remove('hidden');
  }

  const st = systemState || (await window.studioAPI.getSystemStatus());
  const up = await window.studioAPI.checkUpdates();

  const missingPrereqs = st.prereqs.filter((p) => !p.installed);
  const updateRows = up.items
    .map(
      (i) => `
      <div style="display:flex; justify-content:space-between; padding:6px 10px; background:#121521; border-radius:6px;">
        <span><strong>${i.label}</strong> (<code>${i.id}</code>)</span>
        <span style="color:${i.hasUpdate ? '#ffcb6b' : '#c3e88d'}">
          ${i.current} → Latest: ${i.latest} ${i.hasUpdate ? ' (Update Available!)' : ' (Up to date)'}
        </span>
      </div>`
    )
    .join('');

  const missingHtml =
    missingPrereqs.length > 0
      ? `<div style="margin-top:10px; padding:10px; background:rgba(255,203,107,0.1); border:1px solid rgba(255,203,107,0.3); border-radius:8px;">
          <strong style="color:#ffcb6b;">Optional / Missing Apps or Drivers Detected (${missingPrereqs.length}):</strong>
          <div style="margin-top:4px;">${missingPrereqs.map((m) => m.name).join(', ')}</div>
        </div>`
      : `<div style="margin-top:10px; color:#c3e88d;">All core apps, plugins, skills, and drivers are installed!</div>`;

  title.textContent = up.updatesAvailable
    ? 'Updates Available for Your OpenCode Setup!'
    : 'OpenCode Studio Startup Update & Driver Check';

  body.innerHTML = `
    <div>Would you like to update your OpenCode plugins, REA MCP server, Graphify, or install any missing apps/drivers?</div>
    <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">${updateRows}</div>
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

async function refreshFallbackChain() {
  const fb = await window.studioAPI.getFallbackChain();
  document.getElementById('chkAutoSwitchFree').checked = fb.enabled !== false;
  document.getElementById('txtFallbackChain').value = (fb.chain || []).join('\n');
  const statusEl = document.getElementById('fallbackLastStatus');
  if (fb.lastStatus && fb.lastStatus.toModel) {
    statusEl.textContent = `Last Auto-Switch: ${fb.lastStatus.fromModel} → ${fb.lastStatus.toModel} (${fb.lastStatus.reason}) at ${fb.lastStatus.lastSwitchAt}`;
  } else {
    statusEl.textContent = `Active Chain Ready (${(fb.chain || []).length} ranked free models). Auto-switches immediately on HTTP 429 / Quota Exhausted.`;
  }
}

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

// Initialize on load: instant local render (<5ms), non-blocking background network checks
(async function init() {
  await Promise.all([refreshSystemStatus(), refreshProviders(), refreshFallbackChain()]);
  refreshFreeModels();
  setTimeout(() => runStartupCheck(false), 400);
})();
