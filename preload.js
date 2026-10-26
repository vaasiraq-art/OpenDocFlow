'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioAPI', {
  // Core System & Settings
  getSystemStatus: (forceRefresh = false) => ipcRenderer.invoke('studio:get-status', forceRefresh),
  getStudioSettings: () => ipcRenderer.invoke('studio:get-settings'),
  saveStudioSettings: (settings) => ipcRenderer.invoke('studio:save-settings', settings),
  checkUpdates: () => ipcRenderer.invoke('studio:check-updates'),
  updateAllComponents: () => ipcRenderer.invoke('studio:update-all'),
  installPrerequisites: (ids, opts) => ipcRenderer.invoke('studio:install-prereqs', ids, opts),
  runFullKitRestore: () => ipcRenderer.invoke('studio:run-kit-restore'),
  updatePortableKit: () => ipcRenderer.invoke('studio:update-kit'),
  createNewProject: (payload) => ipcRenderer.invoke('studio:new-project', payload),

  // Live Agent Studio & Multi-Agent Hub
  getAgentsHub: () => ipcRenderer.invoke('studio:get-agents-hub'),
  installOpenDocFlowAgentSuite: () => ipcRenderer.invoke('studio:install-opendocflow-suite'),
  runAgentStudioTurn: (payload) => ipcRenderer.invoke('studio:agent-run', payload),
  stopAgentStudioTurn: () => ipcRenderer.invoke('studio:agent-stop'),
  launchCliAgentExternal: (payload) => ipcRenderer.invoke('studio:launch-cli-agent', payload),

  // DocFlow Repo Packager & AI Docs Generator
  packRepository: (payload) => ipcRenderer.invoke('studio:docflow-pack', payload),
  generateAiDocs: (payload) => ipcRenderer.invoke('studio:docflow-generate', payload),
  saveGeneratedDocFile: (payload) => ipcRenderer.invoke('studio:docflow-save-file', payload),

  // Skills & Plugins Harvester
  searchSkills: (query) => ipcRenderer.invoke('studio:search-skills', query),
  installSkill: (repoAndSkill) => ipcRenderer.invoke('studio:install-skill', repoAndSkill),
  importUniversalSkill: (payload) => ipcRenderer.invoke('studio:import-universal-skill', payload),
  bulkImportSkillUrls: (urlsText) => ipcRenderer.invoke('studio:bulk-import-skills', urlsText),
  syncAllAgentsSkills: () => ipcRenderer.invoke('studio:sync-all-agent-skills'),
  installUniversalPlugin: (payload) => ipcRenderer.invoke('studio:install-universal-plugin', payload),
  readSkillOrPluginFile: (payload) => ipcRenderer.invoke('studio:read-item-file', payload),
  saveSkillOrPluginFile: (payload) => ipcRenderer.invoke('studio:save-item-file', payload),

  // MCP Marketplace, Custom Agents & Configs
  getMcpServers: () => ipcRenderer.invoke('studio:get-mcps'),
  getMcpMarketplace: () => ipcRenderer.invoke('studio:get-mcp-marketplace'),
  installMarketplaceMcp: (id) => ipcRenderer.invoke('studio:install-marketplace-mcp', id),
  toggleMcpServer: (payload) => ipcRenderer.invoke('studio:toggle-mcp', payload),
  addMcpServer: (payload) => ipcRenderer.invoke('studio:add-mcp', payload),
  removeMcpServer: (name) => ipcRenderer.invoke('studio:remove-mcp', name),
  getAgentsAndCommands: () => ipcRenderer.invoke('studio:get-agents-commands'),
  saveCustomAgent: (payload) => ipcRenderer.invoke('studio:save-agent', payload),
  deleteCustomAgent: (name) => ipcRenderer.invoke('studio:delete-agent', name),
  saveCustomCommand: (payload) => ipcRenderer.invoke('studio:save-command', payload),
  deleteCustomCommand: (name) => ipcRenderer.invoke('studio:delete-command', name),
  getRawConfigs: () => ipcRenderer.invoke('studio:get-raw-configs'),
  saveRawConfigs: (payload) => ipcRenderer.invoke('studio:save-raw-configs', payload),
  getProfiles: () => ipcRenderer.invoke('studio:get-profiles'),
  saveProfileSnapshot: (name) => ipcRenderer.invoke('studio:save-profile', name),
  switchProfile: (name) => ipcRenderer.invoke('studio:switch-profile', name),

  // Providers, Multi-Key Pool, Scanner & Benchmark
  getProvidersState: () => ipcRenderer.invoke('studio:get-providers'),
  saveProviderKey: (payload) => ipcRenderer.invoke('studio:save-provider', payload),
  removeProviderKey: (id) => ipcRenderer.invoke('studio:remove-provider', id),
  discoverModelsFromKey: (payload) => ipcRenderer.invoke('studio:discover-key-models', payload),
  testSingleProviderKey: (payload) => ipcRenderer.invoke('studio:test-provider-key', payload),
  runProviderBenchmark: (opts) => ipcRenderer.invoke('studio:run-benchmark', opts),
  setDefaultModel: (modelRef) => ipcRenderer.invoke('studio:set-default-model', modelRef),
  addCustomModel: (payload) => ipcRenderer.invoke('studio:add-custom-model', payload),
  fetchFreeCodingModels: () => ipcRenderer.invoke('studio:fetch-free-models'),
  getFallbackChain: () => ipcRenderer.invoke('studio:get-fallback-chain'),
  saveFallbackChain: (payload) => ipcRenderer.invoke('studio:save-fallback-chain', payload),
  triggerNextFreeModelNow: () => ipcRenderer.invoke('studio:switch-next-free-model'),

  // Smart Gateway & Telemetry
  getGatewayTelemetry: () => ipcRenderer.invoke('studio:get-gateway-telemetry'),
  updateGatewaySettings: (settings) => ipcRenderer.invoke('studio:update-gateway-settings', settings),
  connectLocalGatewayToOpenCode: () => ipcRenderer.invoke('studio:connect-local-gateway'),
  connectAllIdesToGateway: () => ipcRenderer.invoke('studio:connect-all-ides'),
  clearPromptCache: () => ipcRenderer.invoke('studio:clear-prompt-cache'),
  getNodeGraphLayout: () => ipcRenderer.invoke('studio:get-node-graph'),
  saveNodeGraphLayout: (graph) => ipcRenderer.invoke('studio:save-node-graph', graph),

  // Cloud Sync & Bug Reporter
  getCloudAccount: () => ipcRenderer.invoke('studio:get-cloud-account'),
  signInCloud: (payload) => ipcRenderer.invoke('studio:cloud-signin', payload),
  signOutCloud: () => ipcRenderer.invoke('studio:cloud-signout'),
  pushCloudSync: (payload) => ipcRenderer.invoke('studio:cloud-push', payload),
  pullCloudSync: (payload) => ipcRenderer.invoke('studio:cloud-pull', payload),
  getBugReports: () => ipcRenderer.invoke('studio:get-bug-reports'),
  reportBugToGitHub: (payload) => ipcRenderer.invoke('studio:report-bug-github', payload),
  clearBugReports: () => ipcRenderer.invoke('studio:clear-bug-reports'),

  // Terminal & OS Utilities
  runTerminalCommand: (cmd, cwd) => ipcRenderer.invoke('studio:terminal-run', { cmd, cwd }),
  stopTerminalCommand: () => ipcRenderer.invoke('studio:terminal-stop'),
  openExternalTerminal: (cwd, cmd) => ipcRenderer.invoke('studio:open-external-terminal', { cwd, cmd }),
  openPath: (targetPath) => ipcRenderer.invoke('studio:open-path', targetPath),
  openExternalUrl: (url) => ipcRenderer.invoke('studio:open-url', url),
  pickDirectory: () => ipcRenderer.invoke('studio:pick-directory'),
  copyTextClipboard: (text) => ipcRenderer.invoke('studio:copy-clipboard', text),
  createDesktopShortcut: () => ipcRenderer.invoke('studio:create-desktop-shortcut'),

  // Event Subscriptions
  onTerminalData: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('studio:terminal-data', listener);
    return () => ipcRenderer.removeListener('studio:terminal-data', listener);
  },
  onAgentStream: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('studio:agent-stream', listener);
    return () => ipcRenderer.removeListener('studio:agent-stream', listener);
  },
  onInstallProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('studio:install-progress', listener);
    return () => ipcRenderer.removeListener('studio:install-progress', listener);
  },
  onGatewayEvent: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('studio:gateway-event', listener);
    return () => ipcRenderer.removeListener('studio:gateway-event', listener);
  },
  onBugCaptured: (cb) => {
    const listener = (_event, bug) => cb(bug);
    ipcRenderer.on('studio:bug-captured', listener);
    return () => ipcRenderer.removeListener('studio:bug-captured', listener);
  }
});
