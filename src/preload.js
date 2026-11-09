// Narrow, typed bridge between the UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Returns the {ok, value, error} envelope as plain data: Error objects lose
// their extra fields (like code) when crossing the context bridge.
const CHANNEL = /^(app|servers|sshconfig|hosts|history|snippets|settings|data|dialog|ssh|exec|shell|sftp|browser):[a-zA-Z]+$/;
const invoke = (channel, ...args) => {
  if (!CHANNEL.test(channel)) return Promise.resolve({ ok: false, error: { message: `Unknown channel ${channel}`, code: null } });
  return ipcRenderer.invoke(channel, ...args);
};

const EVENTS = ['status', 'exec:data', 'exec:exit', 'shell:data', 'shell:exit', 'transfer', 'prompt', 'menu', 'tunnel:error', 'browser:cert', 'browser:download', 'browser:key'];

contextBridge.exposeInMainWorld('hostdeck', {
  invoke,
  on(event, fn) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event ${event}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
  answerPrompt: (id, answer) => ipcRenderer.invoke('prompt:answer', id, answer),
  writeShell: (shellId, data) => ipcRenderer.send('shell:write', shellId, data),
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
});
