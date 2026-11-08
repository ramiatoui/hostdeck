// Electron main process: window, menus, local store and the IPC bridge to
// the SSH engine. The UI never touches Node or the network directly.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu, nativeTheme } = require('electron');
const { Store } = require('./store');
const { SshManager } = require('./ssh');
const { readDefaultSshConfig } = require('./sshconfig');

const DOCS_URL = 'https://ramiatoui.com/hostdeck/docs/';
const REPO_URL = 'https://github.com/ramiatoui/hostdeck';
const ROOT = path.join(__dirname, '..', '..');

let win = null;
let store = null;
let ssh = null;
const pendingPrompts = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

async function cipher() {
  const available = await safeStorage.isAsyncEncryptionAvailable();
  return {
    available: () => available,
    backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'),
    encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64'),
    decrypt: async (b64) => (await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'))).result,
  };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Ask the user something in the UI. Resolves null if the window goes away. */
function prompt(kind, payload) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null);
    const id = crypto.randomUUID();
    pendingPrompts.set(id, resolve);
    if (win.isMinimized()) win.restore();
    win.focus();
    send('prompt', { id, kind, payload });
  });
}

function resolveAllPrompts() {
  for (const resolve of pendingPrompts.values()) resolve(null);
  pendingPrompts.clear();
}

/** Register an IPC handler that returns {ok, value} or {ok:false, error}. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: { message: err.message || String(err), code: err.code || null } };
    }
  });
}

function createWindow() {
  const settings = store.getSettings();
  nativeTheme.themeSource = settings.theme || 'system';
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Hostdeck',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121822' : '#f3f5f8',
    icon: path.join(ROOT, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // The UI blocks unload while a file has unsaved edits; ask instead of
  // silently refusing to close.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes',
      detail: 'A file you are editing has changes that were not saved to the server.',
    });
    if (choice === 0) event.preventDefault();
  });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.on('closed', () => {
    resolveAllPrompts();
    win = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add server', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'add-server') },
        { label: 'Import from SSH config', click: () => send('menu', 'import-ssh-config') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal(DOCS_URL) },
        { label: 'Source code', click: () => shell.openExternal(REPO_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('prompt:answer', (_e, id, answer) => {
    const resolve = pendingPrompts.get(id);
    if (resolve) {
      pendingPrompts.delete(id);
      resolve(answer);
    }
  });

  // App
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    security: store.securityInfo(),
  }));
  handle('app:openExternal', (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened');
    return shell.openExternal(url);
  });
  handle('app:showDataFolder', () => shell.showItemInFolder(store.file));

  // Servers
  handle('servers:list', () => store.listServers());
  handle('servers:save', async (input) => {
    const before = input.id ? store.getServer(input.id) : null;
    const saved = await store.upsertServer(input);
    // Changing how we reach the server makes the open connection stale.
    const keys = ['host', 'port', 'username', 'auth', 'keyPath', 'jumpId', 'legacyAlgorithms', 'agentForward'];
    const secretsChanged = ['password', 'keyText', 'passphrase'].some((k) => input[k] !== undefined);
    if (before && ssh.isConnected(saved.id) && (secretsChanged || keys.some((k) => before[k] !== saved[k]))) {
      ssh.disconnect(saved.id);
    }
    return saved;
  });
  handle('servers:delete', (id) => {
    ssh.disconnect(id);
    store.deleteServer(id);
  });
  handle('servers:duplicate', (id) => store.duplicateServer(id));
  handle('sshconfig:read', () => readDefaultSshConfig());
  handle('sshconfig:import', async (hosts) => {
    const created = {};
    for (const h of hosts) {
      const s = await store.upsertServer({
        name: h.alias,
        host: h.host,
        port: h.port,
        username: h.username,
        auth: h.keyPath ? 'key' : 'agent',
        keyPath: h.keyPath,
      });
      created[h.alias] = s.id;
    }
    // Link ProxyJump aliases to the servers just created (or existing ones by name).
    const all = store.listServers();
    for (const h of hosts) {
      if (!h.proxyJump) continue;
      const first = h.proxyJump.split(',')[0].trim();
      const jumpId = created[first] || (all.find((s) => s.name === first) || {}).id;
      if (jumpId && jumpId !== created[h.alias]) {
        const s = store.getServer(created[h.alias]);
        await store.upsertServer({ ...s, jumpId });
      }
    }
    return Object.keys(created).length;
  });

  // Known hosts, history, snippets, settings
  handle('hosts:list', () => store.listKnownHosts());
  handle('hosts:forget', (key) => {
    const i = key.lastIndexOf(':');
    store.forgetHost(key.slice(0, i), key.slice(i + 1));
  });
  handle('history:get', (serverId) => store.getHistory(serverId));
  handle('history:clear', (serverId) => store.clearHistory(serverId));
  handle('snippets:list', () => store.listSnippets());
  handle('snippets:save', (s) => store.upsertSnippet(s));
  handle('snippets:delete', (id) => store.deleteSnippet(id));
  handle('settings:get', () => store.getSettings());
  handle('settings:update', (patch) => {
    const next = store.updateSettings(patch);
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    return next;
  });

  // Export / import (servers and snippets, never secrets)
  handle('data:export', async () => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export servers',
      defaultPath: 'hostdeck-servers.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, JSON.stringify(store.exportData(), null, 2));
    return res.filePath;
  });
  handle('data:import', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import servers',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return store.importData(JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')));
  });

  // Dialogs
  handle('dialog:pickKey', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a private key',
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('dialog:pickUploads', async (kind) => {
    const res = await dialog.showOpenDialog(win, {
      title: kind === 'folder' ? 'Upload folders' : 'Upload files',
      properties: [kind === 'folder' ? 'openDirectory' : 'openFile', 'multiSelections', 'showHiddenFiles'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // SSH
  handle('ssh:connect', (serverId) => ssh.connect(serverId));
  handle('ssh:disconnect', (serverId) => ssh.disconnect(serverId));
  handle('ssh:connected', () => ssh.connectedIds());
  handle('exec:run', (serverId, command, opts) => ssh.exec(serverId, command, opts));
  handle('exec:cancel', (runId) => ssh.cancelExec(runId));
  handle('shell:open', (serverId, size) => ssh.openShell(serverId, size));
  handle('shell:resize', (shellId, cols, rows) => ssh.resizeShell(shellId, cols, rows));
  handle('shell:close', (shellId) => ssh.closeShell(shellId));
  ipcMain.on('shell:write', (_e, shellId, data) => ssh.writeShell(shellId, data));

  // SFTP
  handle('sftp:home', (serverId) => ssh.home(serverId));
  handle('sftp:list', (serverId, dir) => ssh.list(serverId, dir));
  handle('sftp:read', (serverId, p) => ssh.readFile(serverId, p));
  handle('sftp:write', (serverId, p, content, opts) => ssh.writeFile(serverId, p, content, opts));
  handle('sftp:mkdir', (serverId, p) => ssh.mkdir(serverId, p));
  handle('sftp:rename', (serverId, a, b) => ssh.rename(serverId, a, b));
  handle('sftp:chmod', (serverId, p, mode) => ssh.chmod(serverId, p, mode));
  handle('sftp:remove', (serverId, p) => ssh.remove(serverId, p));
  handle('sftp:upload', (serverId, localPaths, remoteDir, transferId) => ssh.upload(serverId, localPaths, remoteDir, { transferId }));
  handle('sftp:download', async (serverId, remotePath, isDir, transferId) => {
    const name = path.posix.basename(remotePath);
    let target;
    if (isDir) {
      const res = await dialog.showOpenDialog(win, { title: 'Download folder to…', properties: ['openDirectory', 'createDirectory'] });
      if (res.canceled || !res.filePaths[0]) return null;
      target = path.join(res.filePaths[0], name);
    } else {
      const res = await dialog.showSaveDialog(win, { title: 'Save file', defaultPath: path.join(app.getPath('downloads'), name) });
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }
    await ssh.download(serverId, remotePath, target, { transferId });
    return target;
  });
  handle('sftp:reveal', (localPath) => shell.showItemInFolder(localPath));

  for (const ev of ['status', 'exec:data', 'exec:exit', 'shell:data', 'shell:exit', 'transfer']) {
    ssh.on(ev, (payload) => send(ev, payload));
  }
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => event.preventDefault());
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  store = new Store({ dir: app.getPath('userData'), cipher: await cipher() });
  ssh = new SshManager({ store, prompt });
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (ssh) ssh.disconnectAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
