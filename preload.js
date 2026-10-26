const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioAPI', {
  getSystemStatus: () => ipcRenderer.invoke('studio:get-status'),
  checkUpdates: () => ipcRenderer.invoke('studio:check-updates'),
  updateAllComponents: () => ipcRenderer.invoke('studio:update-all'),
  installPrerequisites: (ids) => ipcRenderer.invoke('studio:install-prereqs', ids),
  runFullKitRestore: () => ipcRenderer.invoke('studio:run-kit-restore'),
  updatePortableKit: () => ipcRenderer.invoke('studio:update-kit'),
  createNewProject: (payload) => ipcRenderer.invoke('studio:new-project', payload),
  searchSkills: (query) => ipcRenderer.invoke('studio:search-skills', query),
  installSkill: (repoAndSkill) => ipcRenderer.invoke('studio:install-skill', repoAndSkill),
  getProvidersState: () => ipcRenderer.invoke('studio:get-providers'),
  saveProviderKey: (payload) => ipcRenderer.invoke('studio:save-provider', payload),
  removeProviderKey: (id) => ipcRenderer.invoke('studio:remove-provider', id),
  setDefaultModel: (modelRef) => ipcRenderer.invoke('studio:set-default-model', modelRef),
  addCustomModel: (payload) => ipcRenderer.invoke('studio:add-custom-model', payload),
  fetchFreeCodingModels: () => ipcRenderer.invoke('studio:fetch-free-models'),
  getFallbackChain: () => ipcRenderer.invoke('studio:get-fallback-chain'),
  saveFallbackChain: (payload) => ipcRenderer.invoke('studio:save-fallback-chain', payload),
  triggerNextFreeModelNow: () => ipcRenderer.invoke('studio:switch-next-free-model'),
  runTerminalCommand: (cmd, cwd) => ipcRenderer.invoke('studio:terminal-run', { cmd, cwd }),
  stopTerminalCommand: () => ipcRenderer.invoke('studio:terminal-stop'),
  openExternalTerminal: (cwd, cmd) => ipcRenderer.invoke('studio:open-external-terminal', { cwd, cmd }),
  openPath: (targetPath) => ipcRenderer.invoke('studio:open-path', targetPath),
  openExternalUrl: (url) => ipcRenderer.invoke('studio:open-url', url),
  pickDirectory: () => ipcRenderer.invoke('studio:pick-directory'),
  createDesktopShortcut: () => ipcRenderer.invoke('studio:create-desktop-shortcut'),
  onTerminalData: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('studio:terminal-data', listener);
    return () => ipcRenderer.removeListener('studio:terminal-data', listener);
  }
});
