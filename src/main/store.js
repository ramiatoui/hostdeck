// Local data store. Everything lives in a single JSON file inside the app's
// user-data folder. Secrets (passwords, pasted private keys, passphrases) are
// encrypted with the operating system's keychain through the injected cipher
// (Electron safeStorage in the app), never written in plain text.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_NAME = 'hostdeck.json';
const SCHEMA_VERSION = 1;
const SECRET_FIELDS = ['password', 'keyText', 'passphrase'];
const HISTORY_LIMIT = 100;

const AUTH_TYPES = ['password', 'key', 'agent', 'interactive'];

function emptyData() {
  return {
    version: SCHEMA_VERSION,
    servers: [],
    snippets: [],
    knownHosts: {},
    history: {},
    settings: {
      theme: 'system',
      keepOpenByDefault: false,
      agentPath: '',
      confirmDangerous: true,
    },
  };
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function clampPort(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return 22;
  return n;
}

class Store {
  /**
   * @param {object} opts
   * @param {string} opts.dir folder that holds hostdeck.json
   * @param {{available():boolean, backend():string, encrypt(s:string):string, decrypt(s:string):string}} opts.cipher
   */
  constructor({ dir, cipher }) {
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
    this.cipher = cipher;
    this.data = emptyData();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const base = emptyData();
      this.data = {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings || {}) },
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a copy of an unreadable file instead of silently overwriting it.
        try {
          fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`);
        } catch (_) { /* ignore */ }
      }
      this.data = emptyData();
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- secrets -----------------------------------------------------------

  securityInfo() {
    return {
      encrypted: this.cipher.available(),
      backend: this.cipher.backend(),
      // On Linux without a keyring, Electron falls back to a fixed key.
      weak: !this.cipher.available() || this.cipher.backend() === 'basic_text',
      file: this.file,
    };
  }

  async _seal(value) {
    if (!value) return null;
    if (!this.cipher.available()) {
      throw new Error('Secure storage is not available on this system. Use an SSH key, the SSH agent, or "Ask every time".');
    }
    return this.cipher.encrypt(value);
  }

  async _open(sealed) {
    if (!sealed) return '';
    return this.cipher.decrypt(sealed);
  }

  // ---- servers -----------------------------------------------------------

  _publicServer(s) {
    const { secrets = {}, ...rest } = s;
    return {
      ...rest,
      hasPassword: Boolean(secrets.password),
      hasKeyText: Boolean(secrets.keyText),
      hasPassphrase: Boolean(secrets.passphrase),
    };
  }

  listServers() {
    return this.data.servers.map((s) => this._publicServer(s));
  }

  getServer(id) {
    const s = this.data.servers.find((x) => x.id === id);
    return s ? this._publicServer(s) : null;
  }

  /** Server including decrypted secrets, for connecting. Never sent to the UI. */
  async getServerWithSecrets(id) {
    const s = this.data.servers.find((x) => x.id === id);
    if (!s) return null;
    const out = { ...s };
    delete out.secrets;
    for (const f of SECRET_FIELDS) out[f] = await this._open(s.secrets && s.secrets[f]);
    return out;
  }

  /**
   * Create or update a server. Secret fields follow these rules:
   * undefined keeps the stored value, '' clears it, any other string replaces it.
   */
  async upsertServer(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid server');
    const host = String(input.host || '').trim();
    if (!host) throw new Error('Host is required');
    const auth = AUTH_TYPES.includes(input.auth) ? input.auth : 'password';

    const existing = input.id ? this.data.servers.find((x) => x.id === input.id) : null;
    if (input.jumpId && input.jumpId === input.id) throw new Error('A server cannot be its own jump host');

    // Encrypt new secrets first, so a failure leaves the stored server untouched.
    const sealed = {};
    for (const f of SECRET_FIELDS) {
      if (input[f] === undefined || input[f] === '' || input[f] === null) continue;
      if (f === 'password' && input.askPassword) continue;
      sealed[f] = await this._seal(String(input[f]));
    }

    const server = existing || { id: newId(), createdAt: Date.now(), secrets: {} };
    Object.assign(server, {
      name: String(input.name || '').trim() || host,
      group: String(input.group || '').trim(),
      host,
      port: clampPort(input.port),
      username: String(input.username || '').trim() || 'root',
      auth,
      keyPath: String(input.keyPath || '').trim(),
      askPassword: Boolean(input.askPassword),
      jumpId: input.jumpId || '',
      keepAlive: Math.max(0, parseInt(input.keepAlive, 10) || 30),
      startDir: String(input.startDir || '').trim(),
      color: String(input.color || ''),
      notes: String(input.notes || ''),
      legacyAlgorithms: Boolean(input.legacyAlgorithms),
      agentForward: Boolean(input.agentForward),
      updatedAt: Date.now(),
    });

    server.secrets = server.secrets || {};
    for (const f of SECRET_FIELDS) {
      if (input[f] === undefined) continue;
      if (input[f] === '' || input[f] === null) delete server.secrets[f];
      else if (sealed[f]) server.secrets[f] = sealed[f];
    }
    if (server.askPassword) delete server.secrets.password;

    if (!existing) this.data.servers.push(server);
    this.save();
    return this._publicServer(server);
  }

  deleteServer(id) {
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    for (const s of this.data.servers) if (s.jumpId === id) s.jumpId = '';
    delete this.data.history[id];
    this.save();
  }

  duplicateServer(id) {
    const s = this.data.servers.find((x) => x.id === id);
    if (!s) throw new Error('Server not found');
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = newId();
    copy.name = `${s.name} (copy)`;
    copy.createdAt = Date.now();
    this.data.servers.push(copy);
    this.save();
    return this._publicServer(copy);
  }

  touchServer(id) {
    const s = this.data.servers.find((x) => x.id === id);
    if (s) {
      s.lastUsedAt = Date.now();
      this.save();
    }
  }

  // ---- known hosts -------------------------------------------------------

  getKnownHost(host, port) {
    return this.data.knownHosts[`${host}:${port}`] || null;
  }

  trustHost(host, port, { type, fingerprint }) {
    this.data.knownHosts[`${host}:${port}`] = { type, fingerprint, addedAt: Date.now() };
    this.save();
  }

  forgetHost(host, port) {
    delete this.data.knownHosts[`${host}:${port}`];
    this.save();
  }

  listKnownHosts() {
    return Object.entries(this.data.knownHosts).map(([key, v]) => ({ key, ...v }));
  }

  // ---- history & snippets ------------------------------------------------

  addHistory(serverId, command) {
    const cmd = String(command || '').trim();
    if (!cmd) return;
    const list = (this.data.history[serverId] || []).filter((c) => c !== cmd);
    list.unshift(cmd);
    this.data.history[serverId] = list.slice(0, HISTORY_LIMIT);
    this.save();
  }

  getHistory(serverId) {
    return this.data.history[serverId] || [];
  }

  clearHistory(serverId) {
    delete this.data.history[serverId];
    this.save();
  }

  listSnippets() {
    return this.data.snippets;
  }

  upsertSnippet({ id, name, command }) {
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('Command is required');
    let s = id && this.data.snippets.find((x) => x.id === id);
    if (!s) {
      s = { id: newId() };
      this.data.snippets.push(s);
    }
    s.name = String(name || '').trim() || cmd.slice(0, 40);
    s.command = cmd;
    this.save();
    return s;
  }

  deleteSnippet(id) {
    this.data.snippets = this.data.snippets.filter((s) => s.id !== id);
    this.save();
  }

  // ---- settings ----------------------------------------------------------

  getSettings() {
    return { ...this.data.settings };
  }

  updateSettings(patch) {
    const allowed = Object.keys(emptyData().settings);
    for (const k of Object.keys(patch || {})) {
      if (allowed.includes(k)) this.data.settings[k] = patch[k];
    }
    this.save();
    return this.getSettings();
  }

  // ---- import / export ---------------------------------------------------

  /** Export servers and snippets without any secrets. */
  exportData() {
    return {
      app: 'hostdeck',
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      servers: this.data.servers.map((s) => {
        const { secrets, lastUsedAt, ...rest } = s;
        return rest;
      }),
      snippets: this.data.snippets,
    };
  }

  async importData(payload) {
    if (!payload || payload.app !== 'hostdeck' || !Array.isArray(payload.servers)) {
      throw new Error('This file is not a Hostdeck export');
    }
    const idMap = {};
    let added = 0;
    for (const s of payload.servers) {
      const created = await this.upsertServer({ ...s, id: undefined, jumpId: '' });
      idMap[s.id] = created.id;
      added += 1;
    }
    // Re-link jump hosts using the new ids.
    for (const s of payload.servers) {
      if (s.jumpId && idMap[s.jumpId]) {
        const target = this.data.servers.find((x) => x.id === idMap[s.id]);
        if (target) target.jumpId = idMap[s.jumpId];
      }
    }
    for (const sn of payload.snippets || []) {
      if (sn && sn.command) this.upsertSnippet({ name: sn.name, command: sn.command });
    }
    this.save();
    return { added };
  }
}

module.exports = { Store, AUTH_TYPES };
