// Hostdeck UI. Plain DOM, no framework: the state is small and local.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createEditor } from './editor.js';

const bridge = window.hostdeck;
const api = {
  ...bridge,
  async call(channel, ...args) {
    const res = await bridge.invoke(channel, ...args);
    if (res && res.ok === false) {
      const err = new Error(res.error.message);
      err.code = res.error.code;
      throw err;
    }
    return res ? res.value : undefined;
  },
};
const isMac = api.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl';
const MAX_RUN_OUTPUT = 2 * 1024 * 1024;
const MAX_RUNS = 30;
const COLORS = ['', '#f2b950', '#6fcf97', '#8fb4ff', '#e3a8f0', '#ef6a6a', '#5ad1d1'];
const RISKY = /(\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$|\*))|\bmkfs\b|\bdd\s+.*of=\/dev\/|\b(shutdown|reboot|poweroff|halt)\b|:\(\)\s*\{|>\s*\/dev\/sd[a-z]/i;

const state = {
  servers: [],
  status: {}, // serverId -> { state, message }
  selected: null,
  query: '',
  snippets: [],
  settings: {},
  info: null,
  views: {}, // serverId -> per-server UI state
};
const runsById = new Map();
const transfers = new Map();

// ---------------------------------------------------------------------------
// tiny helpers

function h(tag, attrs, ...children) {
  const el = tag === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const icon = (paths, cls = '') => h('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true', html: paths });
const ICONS = {
  play: '<path d="M7 5v14l11-7z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  dir: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
};

function fmtBytes(n) {
  if (n === undefined || n === null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i += 1; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }) });
}
function fmtMode(mode, type) {
  const c = (bits) => (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
  const t = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
  return t + c(mode >> 6) + c(mode >> 3) + c(mode);
}
function fmtDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}
const joinPath = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const parentOf = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');
const serverById = (id) => state.servers.find((s) => s.id === id);
const statusOf = (id) => (state.status[id] && state.status[id].state) || 'disconnected';

function view(id) {
  if (!state.views[id]) {
    state.views[id] = {
      tab: 'run',
      runs: [],
      cwd: '',
      keepOpen: Boolean(state.settings.keepOpenByDefault),
      history: [],
      draft: '',
      files: { path: null, entries: [], loading: false, selected: null, filter: '', deep: null, deepLoading: false },
      shell: null, // { shellId, term, fit, el }
      editor: null, // { path, file, instance, dirty }
    };
  }
  return state.views[id];
}

// ---------------------------------------------------------------------------
// toasts, menus, modals

function toast(message, kind = 'info', title = '') {
  const el = h('div', { class: `toast ${kind}` }, title ? h('strong', null, `${title} `) : null, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}
function showError(err, title = 'Error') {
  toast(err && err.message ? err.message : String(err), 'error', `${title}.`);
}

let openMenuEl = null;
function closeMenu() {
  if (openMenuEl) openMenuEl.remove();
  openMenuEl = null;
}
function showMenu(anchor, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('hr')); continue; }
    menu.append(h('button', { role: 'menuitem', class: it.danger ? 'danger' : '', onclick: () => { closeMenu(); it.run(); } }, it.label));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))}px`;
  menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4}px`;
  openMenuEl = menu;
  menu.querySelector('button').focus();
}
document.addEventListener('mousedown', (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); });

const modalStack = [];
function openModal({ title, desc, body, foot, wide, onCancel }) {
  const root = document.getElementById('modal-root');
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), desc ? h('p', null, desc) : null),
    body && (!Array.isArray(body) || body.some(Boolean)) ? h('div', { class: 'modal-body' }, body) : null,
    foot ? h('div', { class: 'modal-foot' }, foot) : null);
  const backdrop = h('div', { class: 'backdrop' }, box);
  const prevFocus = document.activeElement;
  const entry = {
    close() {
      backdrop.remove();
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    },
    cancel() {
      entry.close();
      if (onCancel) onCancel();
    },
    el: box,
  };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) entry.cancel(); });
  root.append(backdrop);
  modalStack.push(entry);
  const first = box.querySelector('input:not([type=hidden]):not([disabled]), textarea, select, button.primary');
  if (first) setTimeout(() => first.focus(), 0);
  return entry;
}

function confirmDialog({ title, desc, confirm = 'Confirm', danger = false, extra }) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { m.close(); resolve(v); };
    m = openModal({
      title,
      desc,
      body: extra || null,
      onCancel: () => resolve(false),
      foot: [
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, onclick: () => done(true) }, confirm),
      ],
    });
  });
}

function inputDialog({ title, desc, label, value = '', confirm = 'Save', mono = true }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, class: mono ? 'mono-input' : '', spellcheck: false });
    let m;
    const submit = () => { m.close(); resolve(input.value); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    m = openModal({
      title,
      desc,
      body: h('label', { class: 'field' }, h('span', null, label), input),
      onCancel: () => resolve(null),
      foot: [
        h('button', { class: 'btn', onclick: () => { m.close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: submit }, confirm),
      ],
    });
    setTimeout(() => {
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 && !value.endsWith('/') ? dot : value.length);
    }, 0);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (openMenuEl) return closeMenu();
    const top = modalStack[modalStack.length - 1];
    if (top) { e.preventDefault(); top.cancel(); }
  }
});

// ---------------------------------------------------------------------------
// prompts coming from the SSH engine (host keys, passwords, 2FA)

const promptQueue = [];
let promptOpen = false;
api.on('prompt', (p) => { promptQueue.push(p); nextPrompt(); });

function nextPrompt() {
  if (promptOpen || !promptQueue.length) return;
  promptOpen = true;
  const { id, kind, payload } = promptQueue.shift();
  const answer = (value) => {
    api.answerPrompt(id, value);
    promptOpen = false;
    nextPrompt();
  };
  const who = `${payload.server.username}@${payload.server.host}${payload.server.port !== 22 ? `:${payload.server.port}` : ''}`;
  let m;

  if (kind === 'hostkey') {
    const body = [];
    if (payload.changed) {
      body.push(h('div', { class: 'note warn' },
        h('strong', null, 'The host key has changed. '),
        'This happens after a server is rebuilt or its SSH keys are regenerated, but it can also mean someone is intercepting the connection. Only continue if you know why it changed.'));
      body.push(h('div', { class: 'muted' }, 'Previously trusted'), h('code', { class: 'fingerprint' }, payload.previous));
      body.push(h('div', { class: 'muted' }, `New ${payload.type} key`), h('code', { class: 'fingerprint' }, payload.fingerprint));
    } else {
      body.push(h('p', { class: 'muted', style: { margin: '0 0 6px' } }, `This is the first connection to ${payload.server.host}. Check that the ${payload.type} fingerprint matches the server's before trusting it.`));
      body.push(h('code', { class: 'fingerprint' }, payload.fingerprint));
      body.push(h('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, 'On the server: ', h('span', { class: 'mono' }, 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')));
    }
    m = openModal({
      title: payload.changed ? `Host key changed for ${payload.server.name}` : `Trust ${payload.server.name}?`,
      body,
      onCancel: () => answer(null),
      foot: payload.changed
        ? [
          h('button', { class: 'btn danger', onclick: () => { m.close(); answer('trust'); } }, 'Trust new key'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn primary', onclick: () => { m.close(); answer(null); } }, 'Cancel connection'),
        ]
        : [
          h('button', { class: 'btn', onclick: () => { m.close(); answer(null); } }, 'Cancel'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => { m.close(); answer('once'); } }, 'Connect once'),
          h('button', { class: 'btn primary', onclick: () => { m.close(); answer('trust'); } }, 'Trust and connect'),
        ],
    });
    return;
  }

  if (kind === 'password' || kind === 'passphrase') {
    const input = h('input', { type: 'password', autocomplete: 'off' });
    const submit = () => { m.close(); answer(input.value); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    m = openModal({
      title: kind === 'password' ? `Password for ${who}` : 'Key passphrase',
      desc: kind === 'passphrase' ? (payload.retry ? 'That passphrase did not unlock the key. Try again.' : `Your private key for ${who} is protected with a passphrase.`) : 'Used for this connection only, not saved.',
      body: h('label', { class: 'field' }, h('span', null, kind === 'password' ? 'Password' : 'Passphrase'), input),
      onCancel: () => answer(null),
      foot: [
        h('button', { class: 'btn', onclick: () => { m.close(); answer(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: submit }, 'Connect'),
      ],
    });
    return;
  }

  if (kind === 'keyboard-interactive') {
    const inputs = payload.prompts.map((p) => h('input', { type: p.echo ? 'text' : 'password', autocomplete: 'one-time-code' }));
    const submit = () => { m.close(); answer(inputs.map((i) => i.value)); };
    inputs.forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
    m = openModal({
      title: payload.name || `Sign in to ${who}`,
      desc: payload.instructions || 'The server is asking for the following.',
      body: payload.prompts.map((p, i) => h('label', { class: 'field' }, h('span', null, p.prompt.replace(/:\s*$/, '')), inputs[i])),
      onCancel: () => answer(null),
      foot: [
        h('button', { class: 'btn', onclick: () => { m.close(); answer(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: submit }, 'Continue'),
      ],
    });
    return;
  }
  answer(null);
}

// ---------------------------------------------------------------------------
// data loading

async function refreshServers() {
  state.servers = await api.call('servers:list');
  if (state.selected && !serverById(state.selected)) state.selected = null;
  renderDeck();
}

async function init() {
  const [info, settings, snippets, connected] = await Promise.all([
    api.call('app:info'), api.call('settings:get'), api.call('snippets:list'), api.call('ssh:connected'),
  ]);
  state.info = info;
  state.settings = settings;
  state.snippets = snippets;
  for (const id of connected) state.status[id] = { state: 'connected' };
  applyTheme();
  await refreshServers();
  const recent = [...state.servers].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0];
  if (recent) select(recent.id); else renderMain();
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  for (const v of Object.values(state.views)) if (v.shell) v.shell.term.options.theme = termTheme();
}

// ---------------------------------------------------------------------------
// deck (server list)

function renderDeck() {
  const list = document.getElementById('server-list');
  list.textContent = '';
  const q = state.query.trim().toLowerCase();
  const servers = state.servers
    .filter((s) => !q || [s.name, s.host, s.username, s.group].some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!state.servers.length) {
    list.append(h('p', { class: 'muted', style: { padding: '10px', fontSize: '13px' } }, 'No servers yet.'));
    return;
  }
  if (!servers.length) {
    list.append(h('p', { class: 'muted', style: { padding: '10px', fontSize: '13px' } }, `Nothing matches “${state.query}”.`));
    return;
  }
  const groups = new Map();
  for (const s of servers) {
    const g = s.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const hasGroups = names.some((n) => n);
  for (const g of names) {
    if (hasGroups) list.append(h('div', { class: 'group-name' }, g || 'Other'));
    for (const s of groups.get(g)) {
      const st = statusOf(s.id);
      list.append(h('button', {
        class: `slot${state.selected === s.id ? ' active' : ''}`,
        style: s.color ? { '--slot-color': s.color } : null,
        title: `${s.username}@${s.host}:${s.port}`,
        onclick: () => select(s.id),
        ondblclick: () => connect(s.id).catch(() => {}),
        oncontextmenu: (e) => { e.preventDefault(); serverMenu(e.currentTarget, s); },
      },
      h('span', { class: 'slot-name' }, s.name),
      h('span', { class: `dot ${st}`, title: st }),
      h('span', { class: 'slot-addr' }, `${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}`)));
    }
  }
}

function serverMenu(anchor, s) {
  const connected = statusOf(s.id) === 'connected';
  showMenu(anchor, [
    connected
      ? { label: 'Disconnect', run: () => disconnect(s.id) }
      : { label: 'Connect', run: () => connect(s.id).catch(() => {}) },
    { label: 'Edit…', run: () => editServer(s) },
    { label: 'Duplicate', run: async () => { try { const c = await api.call('servers:duplicate', s.id); await refreshServers(); select(c.id); } catch (e) { showError(e); } } },
    '-',
    { label: 'Delete', danger: true, run: () => deleteServer(s) },
  ]);
}

async function deleteServer(s) {
  const ok = await confirmDialog({ title: `Delete ${s.name}?`, desc: 'The server, its saved credentials and its command history are removed from this computer. Nothing changes on the server itself.', confirm: 'Delete server', danger: true });
  if (!ok) return;
  try {
    const v = state.views[s.id];
    if (v && v.shell) { v.shell.term.dispose(); }
    if (v && v.browser && v.browser.wrap) v.browser.wrap.remove();
    delete state.views[s.id];
    await api.call('servers:delete', s.id);
    if (state.selected === s.id) state.selected = null;
    await refreshServers();
    renderMain();
  } catch (e) { showError(e); }
}

function select(id) {
  state.selected = id;
  renderDeck();
  renderMain();
  api.call('history:get', id).then((hist) => {
    view(id).history = hist;
    if (state.selected === id && view(id).tab === 'run') renderHistory();
  });
}

// ---------------------------------------------------------------------------
// connection

async function connect(id) {
  if (statusOf(id) === 'connected') return;
  try {
    await api.call('ssh:connect', id);
  } catch (err) {
    if (err.code !== 'CANCELLED') showError(err, `Could not connect to ${(serverById(id) || {}).name || 'server'}`);
    throw err;
  }
}

async function disconnect(id) {
  await api.call('ssh:disconnect', id);
}

api.on('status', ({ serverId, state: st, message }) => {
  state.status[serverId] = { state: st, message };
  const v = state.views[serverId];
  if (st === 'disconnected' && v) {
    v.files.entries = [];
    v.files.loading = false;
  }
  renderDeck();
  if (state.selected === serverId) {
    renderHeader();
    if (v && v.tab === 'terminal' && st === 'disconnected') renderPane();
    if (v && v.tab === 'files' && (st === 'connected' || st === 'disconnected') && !v.editor) renderPane();
    if (v && v.tab === 'browser' && (st === 'connected' || st === 'disconnected')) renderPane();
  }
  // A new connection gets a new tunnel; point the server's browser at it.
  if (st === 'connected' && v && v.browser && v.browser.wv) api.call('browser:open', serverId).catch(() => {});
});

// ---------------------------------------------------------------------------
// main area

function renderMain() {
  const main = document.getElementById('main');
  main.textContent = '';
  const s = serverById(state.selected);
  if (!s) {
    main.append(h('div', { class: 'empty' }, h('div', { class: 'empty-inner' },
      state.servers.length
        ? [h('h2', null, 'Pick a server'), h('p', null, 'Choose one from the list to run commands, open a terminal or edit files.')]
        : [
          h('h2', null, 'Add your first server'),
          h('p', null, 'Hostdeck keeps your servers on this computer. Add one by hand, or import the hosts you already have in your SSH config.'),
          h('div', { class: 'actions' },
            h('button', { class: 'btn primary', onclick: () => editServer() }, 'Add server'),
            h('button', { class: 'btn', onclick: importSshConfig }, 'Import from SSH config')),
        ])));
    placeBrowsers();
    return;
  }
  const v = view(s.id);
  main.append(
    h('header', { class: 'host-head', id: 'host-head' }),
    h('div', { class: 'tabs', role: 'tablist' },
      ['run', 'terminal', 'files', 'browser'].map((t, i) => h('button', {
        class: 'tab', role: 'tab', 'aria-selected': String(v.tab === t),
        onclick: () => setTab(t),
      }, { run: 'Run', terminal: 'Terminal', files: 'Files', browser: 'Browser' }[t], h('kbd', null, `${MOD}${isMac ? '' : '+'}${i + 1}`)))),
    h('section', { class: 'pane', id: 'pane' }),
  );
  renderHeader();
  renderPane();
}

function setTab(tab) {
  const v = view(state.selected);
  if (v.tab === tab) return;
  v.tab = tab;
  renderMain();
}

function renderHeader() {
  const el = document.getElementById('host-head');
  const s = serverById(state.selected);
  if (!el || !s) return;
  const st = statusOf(s.id);
  const msg = state.status[s.id] && state.status[s.id].message;
  const jump = s.jumpId && serverById(s.jumpId);
  el.textContent = '';
  el.append(
    h('div', { class: 'host-title' },
      h('div', { class: 'title-row' },
        h('h1', null, s.name),
        s.group ? h('span', { class: 'group-chip', title: `Group: ${s.group}` }, s.group) : null),
      h('div', { class: 'addr' }, `${s.username}@${s.host}:${s.port}`, jump ? h('span', { class: 'muted' }, `  via ${jump.name}`) : null)),
    h('div', { class: 'host-actions' },
      h('span', { class: `state-pill ${st}`, title: msg || '' }, h('span', { class: 'dot' }),
        { connected: 'Connected', connecting: 'Connecting…', error: 'Failed', disconnected: 'Not connected' }[st]),
      st === 'connected'
        ? h('button', { class: 'btn small', onclick: () => disconnect(s.id) }, 'Disconnect')
        : h('button', { class: 'btn small', disabled: st === 'connecting', onclick: () => connect(s.id).catch(() => {}) }, 'Connect'),
      h('button', { class: 'icon-btn', title: 'Server options', 'aria-label': 'Server options', onclick: (e) => serverMenu(e.currentTarget, s) }, icon(ICONS.more))),
  );
}

function renderPane() {
  const pane = document.getElementById('pane');
  if (!pane) return;
  pane.textContent = '';
  const v = view(state.selected);
  if (v.tab === 'run') renderRun(pane);
  else if (v.tab === 'terminal') renderTerminal(pane);
  else if (v.tab === 'files') renderFiles(pane);
  else renderBrowser(pane);
  placeBrowsers();
}

// ---------------------------------------------------------------------------
// Run tab

function renderRun(pane) {
  const id = state.selected;
  const s = serverById(id);
  const v = view(id);

  const ta = h('textarea', {
    id: 'cmd', rows: 1, spellcheck: false, placeholder: `Type a command, then ${MOD}+Enter`, 'aria-label': 'Command',
    oninput: () => { v.draft = ta.value; autosize(); },
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runCommand(); }
      if (e.key === 'ArrowUp' && !ta.value && v.history[0]) { e.preventDefault(); ta.value = v.history[0]; v.draft = ta.value; autosize(); }
    },
  });
  ta.value = v.draft;
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`; };

  const running = v.runs.some((r) => r.running);
  const runBtn = h('button', { class: 'btn primary', id: 'run-btn', onclick: runCommand, disabled: running }, icon(ICONS.play), 'Run');

  const cwd = h('input', { type: 'text', value: v.cwd || '', placeholder: s.startDir || '~ (home)', spellcheck: false, oninput: () => { v.cwd = cwd.value; }, 'aria-label': 'Working directory' });
  const keep = h('input', { type: 'checkbox', checked: v.keepOpen, onchange: () => { v.keepOpen = keep.checked; } });

  const snippets = h('div', { class: 'snippets' },
    state.snippets.map((sn) => h('span', { class: 'chip', title: sn.command },
      h('span', { onclick: () => { ta.value = sn.command; v.draft = sn.command; autosize(); ta.focus(); } }, sn.name),
      h('button', { class: 'x', title: 'Remove snippet', 'aria-label': `Remove ${sn.name}`, onclick: async () => { await api.call('snippets:delete', sn.id); state.snippets = await api.call('snippets:list'); renderPane(); } }, '×'))),
    h('button', { class: 'text-btn', onclick: saveSnippet }, state.snippets.length ? 'Save as snippet' : 'Save this command as a snippet'));

  pane.append(
    h('div', { class: 'composer' },
      h('div', { class: 'cmd-box' }, h('span', { class: 'prompt-sign' }, '$'), ta, runBtn),
      h('div', { class: 'composer-row' },
        h('label', { class: 'cwd' }, 'Run in', cwd),
        h('label', { class: 'check', title: 'Leave the connection open after the command finishes, so the next one starts instantly' }, keep, 'Keep connection open'),
        h('span', { class: 'spacer' }),
        v.runs.length ? h('button', { class: 'text-btn', onclick: () => { v.runs = v.runs.filter((r) => r.running); renderPane(); } }, 'Clear output') : null),
      snippets),
    h('div', { class: 'run-body' },
      h('div', { class: 'runs', id: 'runs' }, v.runs.length ? v.runs.map((r) => r.el) : h('div', { class: 'empty-dir' }, 'Output from your commands shows up here.')),
      h('aside', { class: 'history', id: 'history' })),
  );
  renderHistory();
  setTimeout(() => { autosize(); ta.focus(); }, 0);
}

function renderHistory() {
  const el = document.getElementById('history');
  if (!el) return;
  const id = state.selected;
  const v = view(id);
  el.textContent = '';
  el.append(h('h2', null, 'Recent commands', v.history.length ? h('button', { class: 'text-btn', style: { fontSize: '12px' }, onclick: async () => { await api.call('history:clear', id); v.history = []; renderHistory(); } }, 'Clear') : null));
  if (!v.history.length) el.append(h('div', { class: 'none' }, 'Commands you run on this server are listed here.'));
  for (const c of v.history.slice(0, 40)) {
    el.append(h('button', {
      class: 'hist', title: c,
      onclick: () => { const ta = document.getElementById('cmd'); ta.value = c; v.draft = c; ta.dispatchEvent(new Event('input')); ta.focus(); },
      ondblclick: () => { const ta = document.getElementById('cmd'); ta.value = c; v.draft = c; runCommand(); },
    }, c));
  }
}

async function saveSnippet() {
  const ta = document.getElementById('cmd');
  const command = ta.value.trim();
  if (!command) { toast('Type a command first, then save it as a snippet.'); ta.focus(); return; }
  const name = await inputDialog({ title: 'Save snippet', desc: command, label: 'Name', value: command.split(/\s+/).slice(0, 3).join(' '), mono: false });
  if (name === null) return;
  await api.call('snippets:save', { name, command });
  state.snippets = await api.call('snippets:list');
  renderPane();
}

function makeRunEl(run) {
  run.pre = h('pre', { class: 'waiting' });
  run.foot = h('div', { class: 'run-foot' });
  run.stopBtn = h('button', { class: 'btn small', onclick: () => api.call('exec:cancel', run.runId) }, icon(ICONS.stop), 'Stop');
  run.el = h('article', { class: 'run' },
    h('div', { class: 'run-head' }, h('code', { title: run.command }, run.command),
      run.cwd ? h('span', { class: 'muted mono', style: { fontSize: '12px' } }, run.cwd) : null,
      h('button', { class: 'icon-btn', title: 'Copy output', 'aria-label': 'Copy output', onclick: () => { navigator.clipboard.writeText(run.pre.textContent); toast('Output copied.'); } }, icon(ICONS.copy)),
      h('button', { class: 'icon-btn', title: 'Run again', 'aria-label': 'Run again', onclick: () => runCommand(run.command) }, icon(ICONS.refresh))),
    run.pre, run.foot);
  updateRunFoot(run);
}

function updateRunFoot(run) {
  run.foot.textContent = '';
  if (run.running) {
    run.foot.append(h('span', null, 'Running…'), h('span', { class: 'spacer' }), run.stopBtn);
    return;
  }
  run.pre.classList.remove('waiting');
  if (run.error) {
    run.foot.append(h('span', { class: 'code-bad' }, run.error));
    return;
  }
  const ok = run.code === 0;
  run.foot.append(
    h('span', { class: ok ? 'code-ok' : 'code-bad' }, run.signal ? `Stopped (${run.signal})` : run.code === null ? 'Stopped' : `Exit ${run.code}`),
    h('span', null, fmtDuration(run.durationMs)),
    h('span', null, new Date(run.startedAt).toLocaleTimeString()),
  );
}

async function runCommand(preset) {
  const id = state.selected;
  const v = view(id);
  const ta = document.getElementById('cmd');
  const command = (typeof preset === 'string' ? preset : ta.value).trim();
  if (!command) { ta && ta.focus(); return; }
  if (state.settings.confirmDangerous && RISKY.test(command)) {
    const ok = await confirmDialog({
      title: 'Run this command?',
      desc: `It looks destructive. It will run on ${serverById(id).name} exactly as typed.`,
      extra: h('code', { class: 'fingerprint' }, command),
      confirm: 'Run anyway',
      danger: true,
    });
    if (!ok) return;
  }

  const run = { runId: crypto.randomUUID(), command, cwd: v.cwd.trim(), running: true, startedAt: Date.now(), size: 0 };
  makeRunEl(run);
  runsById.set(run.runId, run);
  v.runs.unshift(run);
  for (const old of v.runs.splice(MAX_RUNS)) runsById.delete(old.runId);
  if (typeof preset !== 'string' && ta) { ta.value = ''; v.draft = ''; }
  if (state.selected === id && v.tab === 'run') renderPane();

  const wasConnected = statusOf(id) === 'connected';
  try {
    await connect(id);
    await api.call('exec:run', id, command, { runId: run.runId, cwd: run.cwd });
    v.history = await api.call('history:get', id);
  } catch (err) {
    run.running = false;
    run.error = err.code === 'CANCELLED' ? 'Connection cancelled' : err.message;
    updateRunFoot(run);
  } finally {
    const busy = v.runs.some((r) => r.running) || v.shell || v.editor || (v.browser && v.browser.wv && !v.browser.start);
    if (!wasConnected && !v.keepOpen && !busy && statusOf(id) === 'connected') await disconnect(id);
    if (state.selected === id && v.tab === 'run') {
      const btn = document.getElementById('run-btn');
      if (btn) btn.disabled = v.runs.some((r) => r.running);
      renderHistory();
    }
  }
}

api.on('exec:data', ({ runId, stream, data }) => {
  const run = runsById.get(runId);
  if (!run || !data) return;
  if (run.size > MAX_RUN_OUTPUT) return;
  run.size += data.length;
  const atBottom = run.pre.scrollHeight - run.pre.scrollTop - run.pre.clientHeight < 30;
  if (stream === 'stderr') run.pre.append(h('span', { class: 'err' }, data));
  else run.pre.append(document.createTextNode(data));
  if (run.size > MAX_RUN_OUTPUT) run.pre.append(h('span', { class: 'err' }, '\n[Output truncated at 2 MB. Redirect to a file for full output.]\n'));
  if (atBottom) run.pre.scrollTop = run.pre.scrollHeight;
});

api.on('exec:exit', ({ runId, code, signal, durationMs }) => {
  const run = runsById.get(runId);
  if (!run) return;
  Object.assign(run, { running: false, code, signal, durationMs });
  updateRunFoot(run);
  const btn = document.getElementById('run-btn');
  const v = state.views[state.selected];
  if (btn && v) btn.disabled = v.runs.some((r) => r.running);
});

// ---------------------------------------------------------------------------
// Terminal tab

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const g = (n) => css.getPropertyValue(n).trim();
  return { background: g('--sunken'), foreground: g('--text'), cursor: g('--amber'), cursorAccent: g('--sunken'), selectionBackground: 'rgba(242,185,80,0.3)' };
}

function renderTerminal(pane) {
  const id = state.selected;
  const v = view(id);
  const st = statusOf(id);

  if (!v.shell) {
    pane.append(h('div', { class: 'empty' }, h('div', { class: 'empty-inner' },
      h('h2', null, 'Interactive terminal'),
      h('p', null, 'A full shell on the server, for editors like vim, long-running tasks and anything that needs input.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: st === 'connecting', onclick: () => openShell(id) }, st === 'connected' ? 'Open terminal' : 'Connect and open terminal')))));
    return;
  }
  pane.append(
    h('div', { class: 'term-bar' },
      h('span', null, v.shell.exited ? 'Session ended.' : 'Session open. The connection stays up while the terminal is open.'),
      h('span', { class: 'spacer' }),
      v.shell.exited
        ? h('button', { class: 'btn small', onclick: () => { v.shell.term.dispose(); v.shell = null; openShell(id); } }, 'Start new session')
        : h('button', { class: 'btn small', onclick: () => api.call('shell:close', v.shell.shellId) }, 'End session')),
    h('div', { class: 'term-wrap' }, v.shell.el),
  );
  requestAnimationFrame(() => { fitShell(v); v.shell.term.focus(); });
}

const shellsById = new Map();

async function openShell(id) {
  const v = view(id);
  try {
    await connect(id);
  } catch (_) { return; }
  const el = h('div', { class: 'term-host' });
  const term = new Terminal({ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: termTheme(), allowProposedApi: false });
  const fit = new FitAddon();
  term.loadAddon(fit);
  v.shell = { shellId: null, term, fit, el, exited: false };
  if (state.selected === id) renderPane();
  term.open(el);
  try { fit.fit(); } catch (_) { /* not visible yet */ }
  try {
    const { shellId } = await api.call('shell:open', id, { cols: term.cols, rows: term.rows });
    v.shell.shellId = shellId;
    shellsById.set(shellId, v);
    term.onData((d) => api.writeShell(shellId, d));
    term.onResize(({ cols, rows }) => api.call('shell:resize', shellId, cols, rows));
    term.attachCustomKeyEventHandler((e) => {
      // Let Ctrl/Cmd+Shift+C / V copy and paste like other terminals.
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyC') {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyV') {
        navigator.clipboard.readText().then((t) => api.writeShell(shellId, t));
        return false;
      }
      return true;
    });
    term.focus();
  } catch (err) {
    showError(err, 'Could not open a terminal');
    term.dispose();
    v.shell = null;
    if (state.selected === id) renderPane();
  }
}

function fitShell(v) {
  if (!v.shell || !v.shell.el.isConnected) return;
  try { v.shell.fit.fit(); } catch (_) { /* hidden */ }
}
window.addEventListener('resize', () => {
  const v = state.views[state.selected];
  if (v && v.tab === 'terminal') fitShell(v);
});

api.on('shell:data', ({ shellId, data }) => {
  const v = shellsById.get(shellId);
  if (v && v.shell) v.shell.term.write(data);
});
api.on('shell:exit', ({ shellId }) => {
  const v = shellsById.get(shellId);
  shellsById.delete(shellId);
  if (!v || !v.shell) return;
  v.shell.exited = true;
  v.shell.term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
  if (state.views[state.selected] === v && v.tab === 'terminal') renderPane();
});

// ---------------------------------------------------------------------------
// Browser tab: web pages loaded through the server's SSH connection.
// Each server's <webview> lives in #browser-layer (outside the re-rendered
// pane, so pages survive tab switches) and is positioned over the pane's slot.

const browsersByServer = () => Object.entries(state.views).filter(([, v]) => v.browser);
const TUNNEL_ERROR_WINDOW = 4000;

function normalizeAddress(input) {
  let text = String(input || '').trim();
  if (!text) return null;
  if (/^\d{1,5}$/.test(text)) text = `localhost:${text}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const port = (text.match(/^[^/]*:(\d+)/) || [])[1];
    text = `${['443', '8443', '9443'].includes(port) ? 'https' : 'http'}://${text}`;
  }
  try {
    const u = new URL(text);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.href;
  } catch (_) {
    return null;
  }
}

function browserState(id) {
  const v = view(id);
  if (!v.browser) {
    v.browser = { wrap: null, wv: null, partition: null, url: '', title: '', loading: false, ready: false, error: null, cert: null, tunnelError: null, ports: null, portsError: null, start: true, address: '' };
  }
  return v.browser;
}

function renderBrowser(pane) {
  const id = state.selected;
  const s = serverById(id);
  const b = browserState(id);
  const st = statusOf(id);

  const address = h('input', {
    class: 'address', id: 'address', type: 'text', spellcheck: false, autocomplete: 'off',
    value: b.start ? b.address : b.url, placeholder: 'localhost:8080', 'aria-label': 'Address',
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); goTo(id, address.value); }
      if (e.key === 'Escape') { address.value = b.start ? b.address : b.url; address.blur(); }
    },
    oninput: () => { if (b.start) b.address = address.value; },
    onfocus: () => address.select(),
  });
  const can = (fn) => Boolean(b.wv && b.ready && !b.start && b.wv[fn]());
  const toolbar = h('div', { class: 'browser-bar' },
    h('button', { class: 'icon-btn', title: 'Back (Alt+←)', 'aria-label': 'Back', disabled: !can('canGoBack'), onclick: () => b.wv.goBack() }, icon(ICONS.back)),
    h('button', { class: 'icon-btn', title: 'Forward (Alt+→)', 'aria-label': 'Forward', disabled: !can('canGoForward'), onclick: () => b.wv.goForward() }, icon(ICONS.forward)),
    b.loading
      ? h('button', { class: 'icon-btn', title: 'Stop', 'aria-label': 'Stop', onclick: () => b.wv.stop() }, icon(ICONS.close))
      : h('button', { class: 'icon-btn', title: `Reload (${MOD}+R)`, 'aria-label': 'Reload', disabled: b.start || !b.wv, onclick: () => reloadBrowser(id) }, icon(ICONS.refresh)),
    h('label', { class: 'address-box' }, h('span', { class: 'via', title: `Pages load through ${s.name}. localhost is the server.` }, `via ${s.name}`), address),
    h('button', { class: 'icon-btn', title: 'Browser options', 'aria-label': 'Browser options', onclick: (e) => browserMenu(e.currentTarget, id) }, icon(ICONS.more)));
  pane.append(toolbar, h('div', { class: 'browser-progress', hidden: !b.loading }));

  const slot = h('div', { class: 'browser-slot', id: 'browser-slot' });
  pane.append(slot);

  if (st !== 'connected') {
    b.overlay = true;
    slot.append(h('div', { class: 'empty' }, h('div', { class: 'empty-inner' },
      h('h2', null, b.wv && !b.start ? `Disconnected from ${s.name}` : 'Browse from the server'),
      h('p', null, b.wv && !b.start
        ? 'Pages load through the SSH connection, so the browser needs it. Reconnect to carry on where you were.'
        : 'Open web pages as if you were on the server. localhost is the server itself, so admin tools that are not open to the internet, like phpMyAdmin or pgAdmin, work here.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: st === 'connecting', onclick: () => reconnectBrowser(id) }, b.wv && !b.start ? 'Reconnect' : 'Connect')))));
  } else if (b.start) {
    b.overlay = true;
    slot.append(renderStartPage(id));
  } else if (b.cert || b.error) {
    b.overlay = true;
    slot.append(renderBrowserError(id));
  } else {
    b.overlay = false;
  }
  placeBrowsers();
  if (b.start && st === 'connected') setTimeout(() => { if (document.activeElement === document.body) address.focus(); }, 0);
}

function renderStartPage(id) {
  const s = serverById(id);
  const b = browserState(id);
  if (b.ports === null && !b.portsLoading) loadPorts(id);
  const chips = b.portsLoading && !b.ports
    ? h('p', { class: 'muted' }, 'Looking for listening ports…')
    : b.portsError
      ? h('p', { class: 'muted' }, 'Could not list the ports on this server. Type an address above instead.')
      : !b.ports || !b.ports.length
        ? h('p', { class: 'muted' }, 'No web ports found. Type an address above if you know where the service listens.')
        : h('div', { class: 'port-list' }, b.ports.map((p) => {
          const label = `${p.host}:${p.port}`;
          return h('button', { class: 'port', onclick: () => goTo(id, label) },
            h('span', { class: 'mono' }, label),
            h('span', { class: 'muted' }, { 80: 'web server', 443: 'web server (HTTPS)', 3000: 'often Grafana or a Node app', 5050: 'often pgAdmin', 8080: 'often phpMyAdmin or an app', 8443: 'web (HTTPS)', 9000: 'often Portainer', 9090: 'often Prometheus or Cockpit' }[p.port] || ''));
        }));
  return h('div', { class: 'browser-start' },
    h('h2', null, `Browse from ${s.name}`),
    h('p', { class: 'muted' }, 'Type an address in the bar above. Pages load through the SSH connection, so localhost and private addresses are the ones the server sees.'),
    h('div', { class: 'section-row' },
      h('h3', null, `Listening on ${s.name}`),
      h('button', { class: 'text-btn', onclick: () => loadPorts(id) }, 'Refresh')),
    chips);
}

async function loadPorts(id) {
  const b = browserState(id);
  b.portsLoading = true;
  try {
    b.ports = await api.call('browser:ports', id);
    b.portsError = null;
  } catch (err) {
    b.portsError = err.message;
    b.ports = [];
  } finally {
    b.portsLoading = false;
  }
  if (state.selected === id && view(id).tab === 'browser' && b.start) renderPane();
}

function friendlyLoadError(b, err) {
  let host = '';
  try { host = new URL(err.url).host; } catch (_) { /* ignore */ }
  const recent = b.tunnelError && Date.now() - b.tunnelError.at < TUNNEL_ERROR_WINDOW ? b.tunnelError.message : null;
  if (recent) return { title: `Could not open ${host || 'the page'}`, text: recent };
  const code = err.code;
  if ([-102, -120, -130].includes(code)) return { title: `Nothing answered on ${host}`, text: `No service accepted the connection on ${host} from the server. Check it is running and the port is right.` };
  if (code === -105 || code === -137) return { title: `Unknown address ${host}`, text: 'The server could not find that address. Check the spelling, or use localhost or an IP address.' };
  if (code === -118 || code === -7) return { title: `${host} took too long`, text: 'The page did not respond in time.' };
  if (code === -100 || code === -101) return { title: `${host} closed the connection`, text: 'The service may expect HTTPS (try https://) or plain HTTP (try http://).' };
  if (code === -107) return { title: `${host} does not speak HTTPS here`, text: 'Try the same address with http:// instead.' };
  return { title: `Could not open ${host || 'the page'}`, text: err.description || `Error ${code}` };
}

function renderBrowserError(id) {
  const b = browserState(id);
  if (b.cert) {
    return h('div', { class: 'empty' }, h('div', { class: 'empty-inner' },
      h('h2', null, `${b.cert.host} has an untrusted certificate`),
      h('p', null, 'Internal tools often use a self-signed certificate. Traffic still goes through your SSH connection, but the certificate cannot prove which service you reached.'),
      h('p', { class: 'muted mono', style: { fontSize: '12px' } }, b.cert.error),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => { b.cert = null; b.error = null; if (b.wv && b.wv.canGoBack()) b.wv.goBack(); else showStart(id); } }, 'Go back'),
        h('button', { class: 'btn primary', onclick: async () => {
          await api.call('browser:allowCert', id, b.cert.host);
          const url = b.cert.url;
          b.cert = null;
          b.error = null;
          b.wv.loadURL(url);
          renderPane();
        } }, `Continue to ${b.cert.host}`))));
  }
  const msg = friendlyLoadError(b, b.error);
  return h('div', { class: 'empty' }, h('div', { class: 'empty-inner' },
    h('h2', null, msg.title),
    h('p', null, msg.text),
    h('p', { class: 'muted mono', style: { fontSize: '12px' } }, b.error.url),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => reloadBrowser(id) }, 'Try again'),
      h('button', { class: 'btn', onclick: () => showStart(id) }, 'Back to start'))));
}

function showStart(id) {
  const b = browserState(id);
  b.start = true;
  b.address = '';
  b.error = null;
  b.cert = null;
  b.ports = null;
  if (state.selected === id) renderPane();
}

function browserMenu(anchor, id) {
  const b = browserState(id);
  showMenu(anchor, [
    { label: 'Start page', run: () => showStart(id) },
    { label: 'Copy address', run: () => { navigator.clipboard.writeText(b.url || ''); toast('Address copied.'); } },
    { label: 'Developer tools', run: () => { if (b.wv && b.ready) b.wv.openDevTools(); } },
    '-',
    { label: 'Clear cookies and site data', danger: true, run: async () => {
      const ok = await confirmDialog({ title: 'Clear browsing data?', desc: `Cookies, saved sign-ins and cache for pages opened through ${serverById(id).name} are removed. You will need to sign in to those tools again.`, confirm: 'Clear data', danger: true });
      if (!ok) return;
      await api.call('browser:clearData', id);
      toast('Browsing data cleared.');
      if (b.wv && !b.start) reloadBrowser(id);
    } },
  ]);
}

async function reconnectBrowser(id) {
  const b = browserState(id);
  try {
    await connect(id);
    await api.call('browser:open', id);
  } catch (_) {
    return;
  }
  if (b.wv && !b.start) reloadBrowser(id);
  else if (state.selected === id) renderPane();
}

function reloadBrowser(id) {
  const b = browserState(id);
  if (!b.wv) return;
  const url = (b.error && b.error.url) || b.url;
  b.error = null;
  b.cert = null;
  if (url) b.wv.loadURL(url); else b.wv.reload();
  if (state.selected === id) renderPane();
}

async function goTo(id, input) {
  const url = normalizeAddress(input);
  if (!url) { toast('Type an address like localhost:8080 or http://10.0.0.5:5050.', 'error', 'Not a web address.'); return; }
  const b = browserState(id);
  try {
    await connect(id);
    const { partition } = await api.call('browser:open', id);
    b.partition = partition;
  } catch (err) {
    if (err.code !== 'CANCELLED') showError(err, 'Could not open the browser');
    return;
  }
  b.start = false;
  b.error = null;
  b.cert = null;
  b.url = url;
  if (!b.wv) createWebview(id, url);
  else b.wv.loadURL(url);
  if (state.selected === id && view(id).tab === 'browser') renderPane();
}

function createWebview(id, url) {
  const b = browserState(id);
  const wv = document.createElement('webview');
  wv.setAttribute('partition', b.partition);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', url);
  const wrap = h('div', { class: 'browser-view' });
  wrap.append(wv);
  document.getElementById('browser-layer').append(wrap);
  b.wv = wv;
  b.wrap = wrap;
  const refresh = () => { if (state.selected === id && view(id).tab === 'browser') renderPane(); };
  const syncBar = () => {
    if (!(state.selected === id && view(id).tab === 'browser')) return;
    const bar = document.querySelector('.browser-bar');
    if (!bar) return;
    const addr = document.getElementById('address');
    if (addr && document.activeElement !== addr && !b.start) addr.value = b.url;
    const [back, fwd] = bar.querySelectorAll('.icon-btn');
    back.disabled = !(b.ready && wv.canGoBack());
    fwd.disabled = !(b.ready && wv.canGoForward());
  };
  wv.addEventListener('dom-ready', () => { b.ready = true; syncBar(); });
  wv.addEventListener('did-start-loading', () => { b.loading = true; refresh(); });
  wv.addEventListener('did-stop-loading', () => { b.loading = false; refresh(); });
  wv.addEventListener('did-navigate', (e) => { b.url = e.url; if (!b.cert) b.error = null; syncBar(); });
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { b.url = e.url; syncBar(); } });
  wv.addEventListener('page-title-updated', (e) => { b.title = e.title; });
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return; // -3: aborted, e.g. by a new navigation
    b.error = { code: e.errorCode, description: e.errorDescription, url: e.validatedURL };
    b.loading = false;
    refresh();
  });
}

// Keep each server's page positioned over the visible slot, hidden otherwise.
function placeBrowsers() {
  const slot = document.getElementById('browser-slot');
  const rect = slot && slot.getBoundingClientRect();
  for (const [id, v] of browsersByServer()) {
    const b = v.browser;
    if (!b.wrap) continue;
    const show = slot && state.selected === id && v.tab === 'browser' && !b.overlay;
    if (show) {
      Object.assign(b.wrap.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      b.wrap.classList.add('on');
    } else {
      b.wrap.classList.remove('on');
      if (b.wrap.contains(document.activeElement)) document.activeElement.blur();
    }
  }
}
window.addEventListener('resize', placeBrowsers);

api.on('tunnel:error', ({ serverId, message }) => {
  const v = state.views[serverId];
  if (v && v.browser) v.browser.tunnelError = { message, at: Date.now() };
});
api.on('browser:cert', ({ serverId, url, host, error }) => {
  const v = state.views[serverId];
  if (!v || !v.browser) return;
  v.browser.cert = { url, host, error };
  if (state.selected === serverId && v.tab === 'browser') renderPane();
});
api.on('browser:download', ({ state: st, file, name }) => {
  if (st === 'completed') toast(h('span', null, `Downloaded ${name}. `, h('button', { class: 'text-btn', onclick: () => api.call('sftp:reveal', file) }, 'Show in folder')));
  else if (st === 'interrupted') toast(`Download of ${name} failed.`, 'error');
});
api.on('browser:key', ({ serverId, action }) => {
  if (state.selected !== serverId) return;
  const b = state.views[serverId] && state.views[serverId].browser;
  if (action.startsWith('tab')) return setTab(['run', 'terminal', 'files', 'browser'][Number(action.slice(3)) - 1]);
  if (!b || !b.wv) return;
  if (action === 'address') { const a = document.getElementById('address'); if (a) a.focus(); }
  if (action === 'reload') reloadBrowser(serverId);
  if (action === 'back' && b.wv.canGoBack()) b.wv.goBack();
  if (action === 'forward' && b.wv.canGoForward()) b.wv.goForward();
});

// ---------------------------------------------------------------------------
// Files tab

function renderFiles(pane) {
  const id = state.selected;
  const v = view(id);
  if (v.editor) return renderEditor(pane);
  const st = statusOf(id);
  if (st !== 'connected') {
    pane.append(h('div', { class: 'empty' }, h('div', { class: 'empty-inner' },
      h('h2', null, 'Browse files'),
      h('p', null, 'Upload, download and edit files on the server over SFTP.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: st === 'connecting', onclick: () => connect(id).then(() => loadDir(id, v.files.path)).catch(() => {}) }, 'Connect and browse')))));
    return;
  }
  const f = v.files;
  const pathInput = h('input', {
    class: 'path-input', type: 'text', value: f.path || '', spellcheck: false, 'aria-label': 'Folder path',
    onkeydown: (e) => { if (e.key === 'Enter') loadDir(id, pathInput.value.trim() || '/'); },
  });
  const listEl = h('div', {
    class: 'files-list', id: 'files-list', tabindex: '0', 'aria-label': 'Files. Use the arrow keys to move, Enter to open, Backspace to go up.',
    onkeydown: (ev) => fileKeys(ev, id, listEl),
  });

  pane.append(
    h('div', { class: 'files-bar' },
      h('button', { class: 'icon-btn', title: 'Parent folder (Backspace)', 'aria-label': 'Parent folder', onclick: () => goUp(id) }, icon(ICONS.up)),
      h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => loadDir(id, f.path) }, icon(ICONS.refresh)),
      pathInput,
      h('label', { class: 'file-search' }, icon('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/>'),
        h('input', {
          id: 'file-search', type: 'search', placeholder: `Search (${MOD}${isMac ? '' : '+'}F)`, value: f.filter, spellcheck: false, autocomplete: 'off', 'aria-label': 'Search files',
          oninput: (e) => { f.filter = e.target.value; f.deep = null; f.selected = null; renderFileRows(); },
          onkeydown: (e) => searchKeys(e, id),
        })),
      h('button', { class: 'btn small', onclick: (e) => showMenu(e.currentTarget, [
        { label: 'New file…', run: () => newFile(id) },
        { label: 'New folder…', run: () => newFolder(id) },
      ]) }, icon(ICONS.plus), 'New'),
      h('button', { class: 'btn small', onclick: (e) => showMenu(e.currentTarget, [
        { label: 'Upload files…', run: () => pickAndUpload(id, 'files') },
        { label: 'Upload folder…', run: () => pickAndUpload(id, 'folder') },
      ]) }, icon(ICONS.upload), 'Upload')),
    listEl,
    h('div', { class: 'transfer', id: 'transfer', hidden: true }, h('span', { id: 'transfer-label' }), h('div', { class: 'bar' }, h('i', { id: 'transfer-bar' }))),
  );

  // Drag files from the desktop to upload them here.
  let depth = 0;
  listEl.addEventListener('dragenter', (e) => { e.preventDefault(); depth += 1; listEl.classList.add('drop'); });
  listEl.addEventListener('dragover', (e) => e.preventDefault());
  listEl.addEventListener('dragleave', () => { depth -= 1; if (depth <= 0) listEl.classList.remove('drop'); });
  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    listEl.classList.remove('drop');
    const paths = [...e.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
    if (paths.length) upload(id, paths);
  });

  if (f.path === null) loadDir(id, null);
  else renderFileRows();
  // Focus the list so the arrow keys work straight away.
  setTimeout(() => { if (listEl.isConnected && (!document.activeElement || document.activeElement === document.body)) listEl.focus({ preventScroll: true }); }, 0);
}

function renderFileRows() {
  const id = state.selected;
  const v = view(id);
  const listEl = document.getElementById('files-list');
  if (!listEl) return;
  const f = v.files;
  listEl.textContent = '';
  if (f.loading && !f.entries.length) { listEl.append(h('div', { class: 'empty-dir' }, 'Loading…')); return; }
  const note = searchNote(id);
  if (note) listEl.append(note);
  if (f.deepLoading) return;
  const list = visibleEntries(f);
  if (!f.entries.length && !f.deep) { listEl.append(h('div', { class: 'empty-dir' }, 'This folder is empty. Drop files here to upload them.')); return; }
  if (!list.length) {
    listEl.append(h('div', { class: 'empty-dir' }, f.deep
      ? `Nothing below ${f.deep.dir} has “${f.deep.query}” in its name.`
      : `Nothing in this folder matches “${f.filter.trim()}”.`));
    return;
  }
  const isDir = (e) => e.type === 'dir' || (e.type === 'link' && e.linkTarget === 'dir');
  const tbody = h('tbody');
  list.forEach((e, index) => {
    const dir = isDir(e);
    const open = () => (dir ? loadDir(id, e.path) : openFile(id, e.path));
    const tr = h('tr', {
      class: `frow${f.selected === e.path ? ' sel' : ''}`,
      'data-index': String(index),
      onclick: () => selectRow(id, index, false),
      ondblclick: open,
      oncontextmenu: (ev) => { ev.preventDefault(); fileMenu(ev.currentTarget.querySelector('.act button'), id, e, dir); },
    },
    h('td', { class: 'name', title: e.rel || e.name }, icon(dir ? ICONS.dir : e.type === 'link' ? ICONS.link : ICONS.file, `ico${dir ? ' dir' : ''}`),
      e.rel && e.rel.includes('/') ? h('span', { class: 'muted' }, e.rel.slice(0, e.rel.length - e.name.length)) : null, e.name),
    h('td', { class: 'num' }, dir ? '' : fmtBytes(e.size)),
    h('td', { class: 'num' }, fmtDate(e.mtime)),
    h('td', { class: 'perm' }, e.mode === undefined ? '' : fmtMode(e.mode, e.type)),
    h('td', { class: 'act' }, h('button', { class: 'icon-btn', 'aria-label': `Actions for ${e.name}`, onclick: (ev) => { ev.stopPropagation(); fileMenu(ev.currentTarget, id, e, dir); } }, icon(ICONS.more))));
    tbody.append(tr);
  });
  listEl.append(h('table', { class: 'files' },
    h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Size'), h('th', null, 'Modified'), h('th', null, 'Permissions'), h('th', null, ''))),
    tbody));
  const sel = listEl.querySelector('tr.frow.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

const isDirEntry = (e) => e.type === 'dir' || (e.type === 'link' && e.linkTarget === 'dir');

// ---- search: filter the folder as you type, or search subfolders on the server
function visibleEntries(f) {
  if (f.deep) return f.deep.results;
  const q = f.filter.trim().toLowerCase();
  return q ? f.entries.filter((e) => e.name.toLowerCase().includes(q)) : f.entries;
}

function searchNote(id) {
  const f = view(id).files;
  const q = f.filter.trim();
  if (f.deepLoading) return h('div', { class: 'search-note' }, h('span', null, `Searching below ${f.path} for “${q}”…`));
  if (f.deep) {
    const n = f.deep.results.length;
    return h('div', { class: 'search-note' },
      h('span', null, `${n} result${n === 1 ? '' : 's'} for “${f.deep.query}” in ${f.deep.dir} and its subfolders${f.deep.truncated ? ', showing the first ones' : ''}`),
      h('button', { class: 'text-btn', onclick: () => clearFileSearch(id, true) }, 'Back to folder'));
  }
  if (!q) return null;
  const n = visibleEntries(f).length;
  return h('div', { class: 'search-note' },
    h('span', null, `${n} of ${f.entries.length} in this folder match “${q}”`),
    h('button', { class: 'text-btn', onclick: () => searchSubfolders(id) }, 'Search subfolders'));
}

async function searchSubfolders(id) {
  const f = view(id).files;
  const q = f.filter.trim();
  if (!q) return;
  f.deepLoading = true;
  f.deep = null;
  f.selected = null;
  renderFileRows();
  try {
    f.deep = await api.call('sftp:find', id, f.path, q);
  } catch (err) {
    showError(err, 'Search failed');
  } finally {
    f.deepLoading = false;
  }
  if (state.selected === id && view(id).tab === 'files' && !view(id).editor) {
    renderFileRows();
    const listEl = document.getElementById('files-list');
    if (listEl && f.deep && f.deep.results.length) { listEl.focus(); selectRow(id, 0); }
  }
}

function clearFileSearch(id, focusList) {
  const f = view(id).files;
  f.filter = '';
  f.deep = null;
  f.selected = null;
  const box = document.getElementById('file-search');
  if (box) box.value = '';
  renderFileRows();
  const listEl = document.getElementById('files-list');
  if (focusList && listEl) listEl.focus();
}

function searchKeys(e, id) {
  const f = view(id).files;
  const listEl = document.getElementById('files-list');
  if (e.key === 'Escape') {
    e.preventDefault();
    if (f.filter || f.deep) clearFileSearch(id, false);
    else if (listEl) listEl.focus();
  } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (e.key === 'Enter' && f.filter.trim() && !f.deep && !visibleEntries(f).length) { searchSubfolders(id); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && f.filter.trim()) { searchSubfolders(id); return; }
    if (listEl && visibleEntries(f).length) { listEl.focus(); selectRow(id, 0); }
  }
}

function selectRow(id, index, scroll = true) {
  const f = view(id).files;
  const e = visibleEntries(f)[index];
  const listEl = document.getElementById('files-list');
  if (!e || !listEl) return;
  f.selected = e.path;
  listEl.querySelectorAll('tr.frow.sel').forEach((r) => r.classList.remove('sel'));
  const tr = listEl.querySelector(`tr.frow[data-index="${index}"]`);
  if (tr) {
    tr.classList.add('sel');
    if (scroll) tr.scrollIntoView({ block: 'nearest' });
  }
}

async function goUp(id) {
  const f = view(id).files;
  const from = f.path || '/';
  if (from === '/') return;
  await loadDir(id, parentOf(from), { select: from });
}

// Keyboard navigation for the file list.
function fileKeys(ev, id, listEl) {
  if (ev.target !== listEl || ev.ctrlKey || ev.metaKey) return;
  const f = view(id).files;
  const entries = visibleEntries(f);
  const i = entries.findIndex((e) => e.path === f.selected);
  const row = listEl.querySelector('tr.frow');
  const page = Math.max(1, Math.floor(listEl.clientHeight / (row ? row.offsetHeight : 32)) - 2);
  const move = (n) => {
    ev.preventDefault();
    if (entries.length) selectRow(id, Math.max(0, Math.min(entries.length - 1, n)));
  };
  const cur = i < 0 ? -1 : i;
  const e = entries[i];
  switch (ev.key) {
    case 'ArrowDown': return move(cur + 1);
    case 'ArrowUp':
      if (ev.altKey) { ev.preventDefault(); return goUp(id); }
      return move(cur < 0 ? 0 : cur - 1);
    case 'Home': return move(0);
    case 'End': return move(entries.length - 1);
    case 'PageDown': return move(Math.max(cur, 0) + page);
    case 'PageUp': return move(Math.max(cur, 0) - page);
    case 'Enter':
    case 'ArrowRight':
      if (!e || (ev.key === 'ArrowRight' && !isDirEntry(e))) return;
      ev.preventDefault();
      return isDirEntry(e) ? loadDir(id, e.path) : openFile(id, e.path);
    case 'Backspace':
    case 'ArrowLeft':
      ev.preventDefault();
      if (f.deep || f.filter) return clearFileSearch(id, true);
      return goUp(id);
    case 'Escape':
      if (f.deep || f.filter) { ev.preventDefault(); clearFileSearch(id, true); }
      return;
    case 'Delete':
      if (e) { ev.preventDefault(); removePath(id, e, isDirEntry(e)); }
      return;
    case 'F2':
      if (e) { ev.preventDefault(); renamePath(id, e); }
      return;
    default:
      // Type a letter to jump to the next name starting with it.
      if (ev.key.length === 1 && !ev.altKey && entries.length) {
        const k = ev.key.toLowerCase();
        for (let n = 1; n <= entries.length; n += 1) {
          const j = (cur + n + entries.length) % entries.length;
          if (entries[j].name.toLowerCase().startsWith(k)) { ev.preventDefault(); return selectRow(id, j); }
        }
      }
  }
}

function fileMenu(anchor, id, e, dir) {
  showMenu(anchor, [
    dir ? { label: 'Open', run: () => loadDir(id, e.path) } : { label: 'Edit', run: () => openFile(id, e.path) },
    { label: 'Download…', run: () => download(id, e.path, dir) },
    '-',
    { label: 'Rename…', run: () => renamePath(id, e) },
    { label: 'Permissions…', run: () => chmodPath(id, e) },
    { label: 'Copy path', run: () => { navigator.clipboard.writeText(e.path); toast('Path copied.'); } },
    '-',
    { label: 'Delete', danger: true, run: () => removePath(id, e, dir) },
  ]);
}

async function loadDir(id, dir, { select = null } = {}) {
  const v = view(id);
  v.files.loading = true;
  let changed = false;
  try {
    const target = dir || (await api.call('sftp:home', id));
    const res = await api.call('sftp:list', id, target);
    changed = res.path !== v.files.path;
    const keep = !changed && v.files.entries.some((e) => e.path === v.files.selected) ? v.files.selected : null;
    v.files.path = res.path;
    v.files.entries = res.entries;
    v.files.selected = select || keep;
    if (changed) {
      v.files.filter = '';
      v.files.deep = null;
      const box = document.getElementById('file-search');
      if (box) box.value = '';
    }
  } catch (err) {
    showError(err, 'Could not open folder');
    if (v.files.path === null) v.files.path = '/';
  } finally {
    v.files.loading = false;
  }
  if (state.selected === id && v.tab === 'files' && !v.editor) {
    const input = document.querySelector('.path-input');
    if (input) input.value = v.files.path;
    const listEl = document.getElementById('files-list');
    if (listEl && changed) listEl.scrollTop = 0;
    renderFileRows();
  }
}

async function newFolder(id) {
  const v = view(id);
  const name = await inputDialog({ title: 'New folder', desc: `In ${v.files.path}`, label: 'Folder name', confirm: 'Create folder' });
  if (!name) return;
  try { await api.call('sftp:mkdir', id, joinPath(v.files.path, name)); await loadDir(id, v.files.path); } catch (e) { showError(e, 'Could not create folder'); }
}

async function newFile(id) {
  const v = view(id);
  const name = await inputDialog({ title: 'New file', desc: `In ${v.files.path}`, label: 'File name', confirm: 'Create and edit' });
  if (!name) return;
  const p = joinPath(v.files.path, name);
  if (v.files.entries.some((e) => e.path === p)) { openFile(id, p); return; }
  try {
    await api.call('sftp:write', id, p, '', {});
    await loadDir(id, v.files.path);
    openFile(id, p);
  } catch (e) { showError(e, 'Could not create file'); }
}

async function renamePath(id, e) {
  const name = await inputDialog({ title: `Rename ${e.name}`, label: 'New name', value: e.name, confirm: 'Rename' });
  if (!name || name === e.name) return;
  const v = view(id);
  try {
    await api.call('sftp:rename', id, e.path, name.startsWith('/') ? name : joinPath(parentOf(e.path), name));
    await loadDir(id, v.files.path);
  } catch (err) { showError(err, 'Could not rename'); }
}

async function chmodPath(id, e) {
  const value = await inputDialog({ title: `Permissions for ${e.name}`, desc: 'Octal mode, for example 644 for files or 755 for folders and scripts.', label: 'Mode', value: e.mode === undefined ? '' : (e.mode & 0o777).toString(8), confirm: 'Apply' });
  if (!value) return;
  if (!/^[0-7]{3,4}$/.test(value.trim())) { toast('Use an octal mode like 644 or 0755.', 'error', 'Invalid mode.'); return; }
  try { await api.call('sftp:chmod', id, e.path, value.trim()); await loadDir(id, view(id).files.path); } catch (err) { showError(err, 'Could not change permissions'); }
}

async function removePath(id, e, dir) {
  const ok = await confirmDialog({
    title: `Delete ${e.name}?`,
    desc: dir ? 'The folder and everything inside it is deleted from the server. This cannot be undone.' : 'The file is deleted from the server. This cannot be undone.',
    extra: h('code', { class: 'fingerprint' }, e.path),
    confirm: dir ? 'Delete folder' : 'Delete file',
    danger: true,
  });
  if (!ok) return;
  try { await api.call('sftp:remove', id, e.path); await loadDir(id, view(id).files.path); } catch (err) { showError(err, 'Could not delete'); }
}

async function pickAndUpload(id, kind) {
  const paths = await api.call('dialog:pickUploads', kind);
  if (paths.length) upload(id, paths);
}

async function upload(id, paths) {
  const v = view(id);
  const dir = v.files.path;
  const transferId = crypto.randomUUID();
  transfers.set(transferId, { label: `Uploading ${paths.length === 1 ? paths[0].split(/[\\/]/).pop() : `${paths.length} items`}` });
  try {
    const res = await api.call('sftp:upload', id, paths, dir, transferId);
    toast(`Uploaded ${res.files} file${res.files === 1 ? '' : 's'} (${fmtBytes(res.bytes)}) to ${dir}.`);
    if (view(id).files.path === dir) await loadDir(id, dir);
  } catch (err) {
    showError(err, 'Upload failed');
  } finally {
    transfers.delete(transferId);
    hideTransfer();
  }
}

async function download(id, remotePath, dir) {
  const transferId = crypto.randomUUID();
  transfers.set(transferId, { label: `Downloading ${remotePath.split('/').pop()}` });
  try {
    const target = await api.call('sftp:download', id, remotePath, dir, transferId);
    if (target) toast(h('span', null, 'Saved to ', h('button', { class: 'text-btn', onclick: () => api.call('sftp:reveal', target) }, target)));
  } catch (err) {
    showError(err, 'Download failed');
  } finally {
    transfers.delete(transferId);
    hideTransfer();
  }
}

function hideTransfer() {
  const el = document.getElementById('transfer');
  if (el && !transfers.size) el.hidden = true;
}

api.on('transfer', ({ transferId, transferred, total }) => {
  const t = transfers.get(transferId);
  const el = document.getElementById('transfer');
  if (!t || !el) return;
  el.hidden = false;
  document.getElementById('transfer-label').textContent = `${t.label}  ${fmtBytes(transferred)} of ${fmtBytes(total)}`;
  document.getElementById('transfer-bar').style.width = `${total ? Math.round((transferred / total) * 100) : 100}%`;
});

// ---------------------------------------------------------------------------
// Editor

async function openFile(id, path) {
  const v = view(id);
  try {
    const file = await api.call('sftp:read', id, path);
    v.editor = { path, file, instance: null, dirty: false, saving: false };
    if (state.selected === id) renderPane();
  } catch (err) {
    showError(err, `Could not open ${path.split('/').pop()}`);
  }
}

function renderEditor(pane) {
  const id = state.selected;
  const v = view(id);
  const ed = v.editor;
  const dirty = h('span', { class: 'dirty', hidden: !ed.dirty }, 'Unsaved changes');
  const saveBtn = h('button', { class: 'btn primary small', onclick: () => saveFile(id) }, 'Save');
  const host = h('div', { class: 'editor-host' });
  pane.append(h('div', { class: 'editor' },
    h('div', { class: 'editor-bar' },
      h('span', { class: 'file', title: ed.path }, ed.path),
      dirty,
      h('span', { class: 'muted', style: { fontSize: '12px' } }, `${MOD}+S to save`),
      saveBtn,
      h('button', { class: 'btn small', onclick: () => closeEditor(id) }, 'Close')),
    host));
  const content = ed.instance ? ed.instance.getValue() : ed.file.content;
  if (ed.instance) ed.instance.destroy();
  ed.instance = createEditor(host, {
    content,
    path: ed.path,
    onChange: () => { ed.dirty = true; dirty.hidden = false; },
    onSave: () => saveFile(id),
  });
  ed.dirtyEl = dirty;
  ed.instance.focus();
}

async function saveFile(id, force = false) {
  const v = view(id);
  const ed = v.editor;
  if (!ed || ed.saving) return;
  ed.saving = true;
  try {
    const res = await api.call('sftp:write', id, ed.path, ed.instance.getValue(), { expect: { mtime: ed.file.mtime, size: ed.file.size }, force });
    ed.file = { ...ed.file, ...res };
    ed.dirty = false;
    if (ed.dirtyEl) ed.dirtyEl.hidden = true;
    toast(`Saved ${ed.path.split('/').pop()}.`);
  } catch (err) {
    if (err.code === 'CONFLICT') {
      ed.saving = false;
      const ok = await confirmDialog({
        title: 'File changed on the server',
        desc: 'Someone or something modified this file after you opened it. Overwrite their changes with yours, or cancel and copy your edits somewhere safe first.',
        confirm: 'Overwrite',
        danger: true,
      });
      if (ok) return saveFile(id, true);
      return;
    }
    showError(err, 'Could not save');
  } finally {
    ed.saving = false;
  }
}

async function closeEditor(id) {
  const v = view(id);
  if (v.editor && v.editor.dirty) {
    const ok = await confirmDialog({ title: 'Discard unsaved changes?', desc: `Your edits to ${v.editor.path.split('/').pop()} will be lost.`, confirm: 'Discard changes', danger: true });
    if (!ok) return;
  }
  if (v.editor && v.editor.instance) v.editor.instance.destroy();
  v.editor = null;
  renderPane();
  loadDir(id, v.files.path);
}

// ---------------------------------------------------------------------------
// Server editor

async function editServer(existing) {
  const s = existing ? { ...existing } : { auth: 'password', port: 22, username: 'root', keepAlive: 30, color: '' };
  const security = state.info.security;
  const others = state.servers.filter((x) => x.id !== s.id);
  const form = {};

  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null);
  const text = (key, attrs = {}) => {
    const el = h('input', { type: 'text', value: s[key] ?? '', spellcheck: false, ...attrs });
    form[key] = el;
    return el;
  };

  const secret = (key, label, has) => {
    const el = h('input', { type: 'password', autocomplete: 'new-password', placeholder: has ? 'Saved. Leave empty to keep it.' : '' });
    form[key] = el;
    const clear = has ? h('button', { type: 'button', class: 'text-btn', onclick: () => { el.dataset.clear = '1'; el.placeholder = 'Will be removed on save'; clear.remove(); } }, 'Remove saved') : null;
    return h('label', { class: 'field' }, h('span', null, label), el, clear);
  };

  // Auth section
  const authBox = h('div');
  let auth = s.auth;
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Authentication' });
  const AUTH = [['password', 'Password'], ['key', 'Private key'], ['agent', 'SSH agent'], ['interactive', '2FA / prompts']];
  const drawSeg = () => {
    seg.textContent = '';
    for (const [k, label] of AUTH) seg.append(h('button', { type: 'button', 'aria-pressed': String(auth === k), onclick: () => { auth = k; drawSeg(); drawAuth(); } }, label));
  };
  const askBox = h('input', { type: 'checkbox', checked: Boolean(s.askPassword) });
  form.askPassword = askBox;

  const drawAuth = () => {
    authBox.textContent = '';
    if (auth === 'password') {
      const pw = secret('password', 'Password', s.hasPassword);
      authBox.append(h('label', { class: 'check', style: { marginBottom: '12px' } }, askBox, 'Ask for the password every time'), pw);
      const sync = () => { pw.hidden = askBox.checked; };
      askBox.onchange = sync;
      sync();
    } else if (auth === 'key') {
      const keyPath = text('keyPath', { placeholder: '~/.ssh/id_ed25519', class: 'mono-input' });
      const browse = h('button', { type: 'button', class: 'btn', onclick: async () => { const p = await api.call('dialog:pickKey'); if (p) keyPath.value = p; } }, 'Browse…');
      const paste = h('textarea', { spellcheck: false, placeholder: s.hasKeyText ? 'A pasted key is saved. Leave empty to keep it.' : '-----BEGIN OPENSSH PRIVATE KEY-----' });
      form.keyText = paste;
      authBox.append(
        field('Key file', h('div', { class: 'inline' }, keyPath, browse), 'The key file stays where it is; only its path is saved.'),
        h('details', { class: 'more', open: s.hasKeyText || undefined },
          h('summary', null, 'Paste a key instead'),
          field('Private key', paste, 'Stored encrypted on this computer. A pasted key is used instead of the key file.')),
        secret('passphrase', 'Passphrase (optional)', s.hasPassphrase),
        h('small', { class: 'muted' }, 'Leave the passphrase empty to be asked when connecting.'),
      );
    } else if (auth === 'agent') {
      const fwd = h('input', { type: 'checkbox', checked: Boolean(s.agentForward) });
      form.agentForward = fwd;
      authBox.append(h('div', { class: 'note' }, api.platform === 'win32'
        ? 'Uses the Windows OpenSSH agent, or Pageant if you set its path in Settings. Add your key with ssh-add first.'
        : 'Uses the SSH agent already running on your computer (SSH_AUTH_SOCK). Add your key with ssh-add first.'),
      h('label', { class: 'check' }, fwd, 'Forward the agent to this server'));
    } else {
      authBox.append(h('div', { class: 'note' }, 'For servers with two-factor login or custom prompts. Hostdeck shows each question the server asks when you connect.'));
    }
  };
  drawSeg();
  drawAuth();

  let color = s.color || '';
  const swatches = h('div', { class: 'swatches' });
  const drawSwatches = () => {
    swatches.textContent = '';
    for (const c of COLORS) {
      swatches.append(h('button', {
        type: 'button', class: `swatch${c ? '' : ' none'}`, style: c ? { background: c } : null,
        'aria-pressed': String(color === c), 'aria-label': c ? `Color ${c}` : 'No color',
        onclick: () => { color = c; drawSwatches(); },
      }));
    }
  };
  drawSwatches();

  const jump = h('select', null, h('option', { value: '' }, 'None (connect directly)'), others.map((o) => h('option', { value: o.id, selected: s.jumpId === o.id }, o.name)));
  form.jumpId = jump;
  const legacy = h('input', { type: 'checkbox', checked: Boolean(s.legacyAlgorithms) });
  form.legacyAlgorithms = legacy;

  const portInput = h('input', { type: 'number', min: 1, max: 65535, value: s.port || 22 });
  const body = [
    security.weak ? h('div', { class: 'note warn' }, security.encrypted
      ? 'No system keyring was found, so saved passwords are only lightly protected. Prefer an SSH key, the SSH agent or “Ask every time”.'
      : 'Secure storage is not available on this computer, so passwords and pasted keys cannot be saved. Use a key file, the SSH agent or “Ask every time”.') : null,
    h('div', { class: 'row c2' }, field('Name', text('name', { placeholder: 'prod-web' })), field('Group', text('group', { placeholder: 'Production', list: 'groups' }))),
    h('datalist', { id: 'groups' }, [...new Set(state.servers.map((x) => x.group).filter(Boolean))].map((g) => h('option', { value: g }))),
    h('div', { class: 'row addr' }, field('Host', text('host', { placeholder: '51.15.0.10 or server.example.com', class: 'mono-input' })), field('Port', portInput)),
    field('Username', text('username', { placeholder: 'ubuntu', class: 'mono-input' })),
    h('div', { class: 'field' }, h('span', null, 'Sign in with'), seg),
    authBox,
    h('details', { class: 'more' },
      h('summary', null, 'More options'),
      field('Jump host', jump, 'Connect through another saved server (bastion), like ProxyJump.'),
      h('div', { class: 'row c2' },
        field('Start folder', text('startDir', { placeholder: '/var/www', class: 'mono-input' }), 'Used by Files and new terminals.'),
        field('Keepalive (seconds)', (() => { const el = h('input', { type: 'number', min: 0, value: s.keepAlive ?? 30 }); form.keepAlive = el; return el; })(), '0 turns it off.')),
      h('div', { class: 'field' }, h('span', null, 'Color'), swatches),
      field('Notes', (() => { const el = h('textarea', { style: { fontFamily: 'var(--sans)', fontSize: '13px', height: '70px' } }); el.value = s.notes || ''; form.notes = el; return el; })()),
      h('label', { class: 'check' }, legacy, 'Allow legacy algorithms (for old servers and network devices)')),
  ];

  let m;
  const save = async (andConnect) => {
    const val = (k) => (form[k] ? form[k].value : undefined);
    const secretVal = (k) => {
      const el = form[k];
      if (!el) return undefined;
      if (el.dataset.clear) return '';
      return el.value ? el.value : undefined;
    };
    const input = {
      id: s.id,
      name: val('name'),
      group: val('group'),
      host: val('host'),
      port: portInput.value,
      username: val('username'),
      auth,
      askPassword: auth === 'password' && askBox.checked,
      keyPath: auth === 'key' ? val('keyPath') : (s.keyPath || ''),
      jumpId: jump.value,
      startDir: val('startDir'),
      keepAlive: form.keepAlive.value,
      color,
      notes: form.notes.value,
      legacyAlgorithms: legacy.checked,
      agentForward: form.agentForward ? form.agentForward.checked : Boolean(s.agentForward),
    };
    if (auth === 'password' && !askBox.checked) input.password = secretVal('password');
    if (auth === 'key') {
      input.keyText = secretVal('keyText');
      input.passphrase = secretVal('passphrase');
    }
    if (!String(input.host || '').trim()) { toast('Enter the server address.', 'error', 'Host is required.'); form.host.focus(); return; }
    if (auth === 'key' && !input.keyPath && !input.keyText && !s.hasKeyText) { toast('Choose a key file or paste a private key.', 'error', 'Key is required.'); return; }
    try {
      const saved = await api.call('servers:save', input);
      m.close();
      await refreshServers();
      select(saved.id);
      if (andConnect) connect(saved.id).catch(() => {});
    } catch (err) { showError(err, 'Could not save server'); }
  };

  m = openModal({
    title: existing ? `Edit ${existing.name}` : 'Add server',
    body,
    wide: true,
    foot: [
      existing ? h('button', { class: 'btn danger', onclick: () => { m.close(); deleteServer(existing); } }, 'Delete') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn', onclick: () => save(false) }, 'Save'),
      h('button', { class: 'btn primary', onclick: () => save(true) }, 'Save and connect'),
    ],
  });
  setTimeout(() => (existing ? form.name : form.host).focus(), 0);
}

// ---------------------------------------------------------------------------
// Import from ~/.ssh/config

async function importSshConfig() {
  let res;
  try { res = await api.call('sshconfig:read'); } catch (err) { showError(err, 'Could not read SSH config'); return; }
  if (!res.hosts.length) {
    await confirmDialog({ title: 'No hosts found', desc: `There are no Host entries in ${res.file}.`, confirm: 'OK' });
    return;
  }
  const existing = new Set(state.servers.map((s) => `${s.host}:${s.port}:${s.username}`));
  const checks = res.hosts.map((hst) => {
    const dup = existing.has(`${hst.host}:${hst.port}:${hst.username || 'root'}`);
    return { hst, box: h('input', { type: 'checkbox', checked: !dup }), dup };
  });
  let m;
  m = openModal({
    title: 'Import from SSH config',
    desc: `Found ${res.hosts.length} host${res.hosts.length === 1 ? '' : 's'} in ${res.file}. Keys stay where they are; only their paths are saved.`,
    wide: true,
    body: h('div', { class: 'list-box' }, checks.map(({ hst, box, dup }) => h('label', null, box,
      h('span', { class: 'grow' }, h('strong', null, hst.alias), '  ', h('span', { class: 'mono muted', style: { fontSize: '12px' } }, `${hst.username ? `${hst.username}@` : ''}${hst.host}:${hst.port}${hst.proxyJump ? ` via ${hst.proxyJump}` : ''}`)),
      dup ? h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Already added') : null))),
    foot: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const picked = checks.filter((c) => c.box.checked).map((c) => ({ ...c.hst, username: c.hst.username || 'root' }));
        if (!picked.length) { m.close(); return; }
        try {
          const n = await api.call('sshconfig:import', picked);
          m.close();
          await refreshServers();
          toast(`Imported ${n} server${n === 1 ? '' : 's'}.`);
          if (!state.selected && state.servers[0]) select(state.servers[0].id);
        } catch (err) { showError(err, 'Import failed'); }
      } }, 'Import selected'),
    ],
  });
}

// ---------------------------------------------------------------------------
// Settings

async function openSettings() {
  const [settings, hosts] = await Promise.all([api.call('settings:get'), api.call('hosts:list')]);
  const info = state.info;
  const theme = h('select', null, [['system', 'Match system'], ['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => h('option', { value: v, selected: settings.theme === v }, l)));
  const keep = h('input', { type: 'checkbox', checked: settings.keepOpenByDefault });
  const risky = h('input', { type: 'checkbox', checked: settings.confirmDangerous });
  const agent = h('input', { type: 'text', value: settings.agentPath || '', class: 'mono-input', placeholder: api.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent or pageant' : '$SSH_AUTH_SOCK', spellcheck: false });

  const hostList = h('div', { class: 'list-box' });
  const drawHosts = (list) => {
    hostList.textContent = '';
    if (!list.length) hostList.append(h('div', { class: 'item muted' }, 'No trusted hosts yet.'));
    for (const k of list) {
      hostList.append(h('div', { class: 'item' },
        h('span', { class: 'grow' }, h('span', { class: 'mono' }, k.key), h('br'), h('span', { class: 'mono muted', style: { fontSize: '11.5px' } }, `${k.type}  ${k.fingerprint}`)),
        h('button', { class: 'btn small', onclick: async () => { await api.call('hosts:forget', k.key); drawHosts(await api.call('hosts:list')); } }, 'Forget')));
    }
  };
  drawHosts(hosts);

  const sec = info.security;
  const backendLabel = !sec.encrypted ? 'Not available' : sec.backend === 'os' ? (api.platform === 'darwin' ? 'macOS Keychain' : 'Windows DPAPI') : sec.weak ? 'Basic (no keyring found)' : `System keyring (${sec.backend})`;

  let m;
  m = openModal({
    title: 'Settings',
    wide: true,
    body: [
      h('div', { class: 'section-title' }, 'General'),
      h('label', { class: 'field' }, h('span', null, 'Theme'), theme),
      h('label', { class: 'check', style: { marginBottom: '10px' } }, keep, 'Keep connections open after running a command'),
      h('label', { class: 'check', style: { marginBottom: '14px' } }, risky, 'Ask before running commands that look destructive (rm -rf /, reboot, mkfs…)'),
      h('label', { class: 'field' }, h('span', null, 'SSH agent path'), agent, h('small', null, 'Leave empty to use the default agent.')),
      h('div', { class: 'section-title' }, 'Trusted host keys'),
      hostList,
      h('div', { class: 'section-title' }, 'Your data'),
      h('dl', { class: 'kv' },
        h('dt', null, 'Stored in'), h('dd', { class: 'mono', style: { fontSize: '12px' } }, sec.file),
        h('dt', null, 'Secret storage'), h('dd', null, backendLabel),
        h('dt', null, 'Version'), h('dd', null, `Hostdeck ${info.version}`)),
      h('div', { class: 'inline', style: { flexWrap: 'wrap' } },
        h('button', { class: 'btn small', onclick: () => api.call('app:showDataFolder') }, 'Show data folder'),
        h('button', { class: 'btn small', onclick: async () => { const p = await api.call('data:export'); if (p) toast(`Exported to ${p}. Passwords and keys are not included.`); } }, 'Export servers…'),
        h('button', { class: 'btn small', onclick: async () => { try { const r = await api.call('data:import'); if (r) { await refreshServers(); toast(`Imported ${r.added} server${r.added === 1 ? '' : 's'}.`); } } catch (e) { showError(e, 'Import failed'); } } }, 'Import servers…'),
        h('button', { class: 'btn small', onclick: () => api.call('app:openExternal', 'https://ramiatoui.com/hostdeck/docs/') }, 'Documentation')),
    ],
    foot: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        state.settings = await api.call('settings:update', { theme: theme.value, keepOpenByDefault: keep.checked, confirmDangerous: risky.checked, agentPath: agent.value.trim() });
        applyTheme();
        m.close();
      } }, 'Save settings'),
    ],
  });
}

// ---------------------------------------------------------------------------
// global wiring

document.getElementById('add-server').addEventListener('click', () => editServer());
document.getElementById('open-import').addEventListener('click', importSshConfig);
document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('search').addEventListener('input', (e) => { state.query = e.target.value; renderDeck(); });

api.on('menu', (action) => {
  if (modalStack.length) return;
  if (action === 'add-server') editServer();
  else if (action === 'import-ssh-config') importSshConfig();
  else if (action === 'settings') openSettings();
});

document.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || modalStack.length) return;
  if (e.key === 'k') { e.preventDefault(); document.getElementById('search').focus(); }
  if (e.key === 'f' && state.selected && view(state.selected).tab === 'files' && !view(state.selected).editor) {
    const box = document.getElementById('file-search');
    if (box) { e.preventDefault(); box.focus(); box.select(); }
  }
  if (state.selected && ['1', '2', '3', '4'].includes(e.key) && !e.shiftKey) {
    e.preventDefault();
    setTab(['run', 'terminal', 'files', 'browser'][Number(e.key) - 1]);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (Object.values(state.views).some((v) => v.editor && v.editor.dirty)) e.returnValue = false;
});

init().catch((err) => showError(err, 'Hostdeck failed to start'));
