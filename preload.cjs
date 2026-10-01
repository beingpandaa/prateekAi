const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('prateekAi', {
  settings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: data => ipcRenderer.invoke('settings:save', data),
  sessionPreferences: data => ipcRenderer.invoke('session:preferences', data),
  refreshModels: force => ipcRenderer.invoke('models:refresh', { force: force === true }),
  setAppearance: value => ipcRenderer.invoke('appearance:set', value),
  setTextSize: value => ipcRenderer.invoke('appearance:text-size', value),
  contentState: () => ipcRenderer.invoke('content:state'),
  showContent: options => ipcRenderer.invoke('window:show-content', options),
  showConfiguration: () => ipcRenderer.invoke('window:show-config'),
  hideContent: () => ipcRenderer.invoke('window:hide-content'),
  closeContent: () => ipcRenderer.invoke('window:content-close'),
  resizeContent: size => ipcRenderer.invoke('window:resize-content', size),
  setMotion: value => ipcRenderer.invoke('appearance:motion', value),
  setLayout: focus => ipcRenderer.invoke('window:layout', focus),
  connectChatGPT: () => ipcRenderer.invoke('auth:connect'),
  cancelChatGPT: () => ipcRenderer.invoke('auth:cancel'),
  disconnectChatGPT: () => ipcRenderer.invoke('auth:disconnect'),
  start: data => ipcRenderer.invoke('listen:start', data),
  stop: () => ipcRenderer.invoke('listen:stop'),
  audio: (source, data) => ipcRenderer.send('audio:chunk', source, data),
  captureFailure: message => ipcRenderer.invoke('capture:failed', message),
  ask: data => ipcRenderer.invoke('answer:ask', data),
  submitPending: data => ipcRenderer.invoke('answer:submit-pending', data),
  testVoiceCommand: data => ipcRenderer.invoke('voice:test', data),
  diagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  cancelAnswer: () => ipcRenderer.invoke('answer:cancel'),
  clear: () => ipcRenderer.invoke('session:clear'),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  onEvent: fn => {
    const listener = (_event, data) => fn(data);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  }
});
