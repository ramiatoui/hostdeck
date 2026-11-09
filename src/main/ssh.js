// SSH engine: connections, commands, interactive shells and SFTP.
// It has no Electron dependency so it can be tested with plain Node.
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const posix = path.posix;
const { Client, utils } = require('ssh2');
const { expandHome } = require('./sshconfig');
const { startSocksServer } = require('./socks');
const { parseListeningPorts, LIST_PORTS_COMMAND } = require('./ports');

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_JUMP_DEPTH = 5;

const LEGACY_ALGORITHMS = {
  kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'] },
  cipher: { append: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'] },
  serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] },
  hmac: { append: ['hmac-sha1'] },
};

class SshError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fingerprintOf(keyBuffer) {
  const hash = crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
  return `SHA256:${hash}`;
}

function keyTypeOf(keyBuffer) {
  try {
    // The raw host key starts with a length-prefixed type string.
    const len = keyBuffer.readUInt32BE(0);
    return keyBuffer.subarray(4, 4 + len).toString('ascii');
  } catch (_) {
    return 'unknown';
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function friendlyError(err, server) {
  if (!err) return new SshError('UNKNOWN', 'Unknown error');
  if (err instanceof SshError) return err;
  const where = server ? `${server.host}:${server.port}` : 'the server';
  const map = {
    ECONNREFUSED: `Connection refused by ${where}. Is SSH running on that port?`,
    ENOTFOUND: `Could not resolve host ${server ? server.host : ''}.`,
    EAI_AGAIN: `Could not resolve host ${server ? server.host : ''} (DNS lookup failed).`,
    ETIMEDOUT: `Timed out connecting to ${where}.`,
    EHOSTUNREACH: `Host ${where} is unreachable.`,
    ENETUNREACH: 'Network is unreachable.',
    ECONNRESET: 'Connection was reset by the server.',
  };
  if (err.code && map[err.code]) return new SshError(err.code, map[err.code]);
  if (err.level === 'client-authentication') {
    return new SshError('AUTH_FAILED', `Authentication failed for ${server ? server.username : 'user'}@${where}. Check the username, password or key.`);
  }
  if (err.level === 'client-timeout' || /Timed out while waiting for handshake/i.test(err.message)) {
    return new SshError('ETIMEDOUT', `Timed out waiting for the SSH handshake with ${where}.`);
  }
  if (/no matching|handshake failed/i.test(err.message)) {
    return new SshError('ALGO', `${err.message}. Try enabling "Allow legacy algorithms" for this server.`);
  }
  return new SshError(err.code || 'SSH_ERROR', err.message || String(err));
}

function modeType(mode) {
  const t = mode & 0o170000;
  if (t === 0o040000) return 'dir';
  if (t === 0o120000) return 'link';
  if (t === 0o100000) return 'file';
  return 'other';
}

function looksBinary(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  return sample.includes(0);
}

function promisify(fn, ctx) {
  return (...args) => new Promise((resolve, reject) => {
    fn.call(ctx, ...args, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

/**
 * Events emitted:
 *  'status'      { serverId, state: 'connecting'|'connected'|'disconnected'|'error', message? }
 *  'exec:data'   { runId, stream: 'stdout'|'stderr', data }
 *  'exec:exit'   { runId, code, signal, durationMs }
 *  'shell:data'  { shellId, data }
 *  'shell:exit'  { shellId }
 *  'transfer'    { transferId, file, transferred, total, done? }
 */
class SshManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {(kind:string, payload:object) => Promise<any>} opts.prompt asks the user; resolves null when cancelled
   * @param {object} [opts.env] environment (for agent lookup)
   * @param {string} [opts.platform]
   */
  constructor({ store, prompt, env = process.env, platform = process.platform }) {
    super();
    this.store = store;
    this.prompt = prompt;
    this.env = env;
    this.platform = platform;
    this.readyTimeout = 20000;
    this.conns = new Map(); // serverId -> { client, jumps: Client[], sftp, pending }
    this.runs = new Map(); // runId -> stream
    this.shells = new Map(); // shellId -> { stream, serverId }
    this.proxies = new Map(); // serverId -> Promise<{ port, close }>
  }

  // ---- connection --------------------------------------------------------

  isConnected(serverId) {
    const c = this.conns.get(serverId);
    return Boolean(c && c.client && c.ready);
  }

  connectedIds() {
    return [...this.conns.entries()].filter(([, c]) => c.ready).map(([id]) => id);
  }

  async connect(serverId) {
    const existing = this.conns.get(serverId);
    if (existing && existing.ready) return { serverId, reused: true };
    if (existing && existing.pending) return existing.pending;

    const entry = { client: null, jumps: [], sftp: null, ready: false, pending: null };
    this.conns.set(serverId, entry);
    this.emit('status', { serverId, state: 'connecting' });

    entry.pending = (async () => {
      try {
        const { client, jumps } = await this._open(serverId, 0, []);
        entry.client = client;
        entry.jumps = jumps;
        entry.ready = true;
        client.on('close', () => this._onClosed(serverId, client));
        client.on('error', () => { /* surfaced through close */ });
        this.store.touchServer(serverId);
        this.emit('status', { serverId, state: 'connected' });
        return { serverId, reused: false };
      } catch (err) {
        this.conns.delete(serverId);
        const e = friendlyError(err, this.store.getServer(serverId));
        this.emit('status', { serverId, state: 'error', message: e.message });
        throw e;
      } finally {
        entry.pending = null;
      }
    })();
    return entry.pending;
  }

  _onClosed(serverId, client) {
    const entry = this.conns.get(serverId);
    if (!entry || entry.client !== client) return;
    for (const j of entry.jumps) j.end();
    for (const [shellId, sh] of this.shells) {
      if (sh.serverId === serverId) {
        this.shells.delete(shellId);
        this.emit('shell:exit', { shellId });
      }
    }
    this.conns.delete(serverId);
    this.stopProxy(serverId);
    this.emit('status', { serverId, state: 'disconnected' });
  }

  disconnect(serverId) {
    const entry = this.conns.get(serverId);
    if (!entry) return;
    if (entry.client) entry.client.end();
    for (const j of entry.jumps) j.end();
    this.conns.delete(serverId);
    this.stopProxy(serverId);
    this.emit('status', { serverId, state: 'disconnected' });
  }

  disconnectAll() {
    for (const id of [...this.conns.keys()]) this.disconnect(id);
  }

  /** Open a client for a server, going through its jump host chain if any. */
  async _open(serverId, depth, chain) {
    if (depth > MAX_JUMP_DEPTH) throw new SshError('JUMP_LOOP', 'Too many jump hosts (or a loop in the jump host chain).');
    if (chain.includes(serverId)) throw new SshError('JUMP_LOOP', 'The jump host chain contains a loop.');
    const server = await this.store.getServerWithSecrets(serverId);
    if (!server) throw new SshError('NOT_FOUND', 'Server not found');

    let sock;
    let jumps = [];
    if (server.jumpId) {
      const jump = await this._open(server.jumpId, depth + 1, [...chain, serverId]);
      jumps = [...jump.jumps, jump.client];
      try {
        sock = await new Promise((resolve, reject) => {
          jump.client.forwardOut('127.0.0.1', 0, server.host, server.port, (err, stream) => (err ? reject(err) : resolve(stream)));
        });
      } catch (err) {
        for (const j of jumps) j.end();
        throw new SshError('JUMP_FAILED', `Jump host could not reach ${server.host}:${server.port}: ${err.message}`);
      }
    }

    try {
      const client = await this._handshake(server, sock);
      return { client, jumps };
    } catch (err) {
      for (const j of jumps) j.end();
      throw err;
    }
  }

  async _buildAuth(server) {
    const cfg = {};
    if (server.auth === 'password') {
      let pw = server.password;
      if (server.askPassword || !pw) {
        pw = await this.prompt('password', { server: this._label(server) });
        if (pw === null || pw === undefined) throw new SshError('CANCELLED', 'Connection cancelled');
      }
      cfg.password = pw;
      cfg._password = pw;
    } else if (server.auth === 'key') {
      let keyData = server.keyText;
      if (!keyData) {
        if (!server.keyPath) throw new SshError('NO_KEY', 'No private key set for this server.');
        try {
          keyData = fs.readFileSync(expandHome(server.keyPath), 'utf8');
        } catch (err) {
          throw new SshError('NO_KEY', `Cannot read private key ${server.keyPath}: ${err.message}`);
        }
      }
      let passphrase = server.passphrase || undefined;
      let parsed = utils.parseKey(keyData, passphrase);
      let attempts = 0;
      while (parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message) && attempts < 3) {
        passphrase = await this.prompt('passphrase', { server: this._label(server), retry: attempts > 0 });
        if (passphrase === null || passphrase === undefined) throw new SshError('CANCELLED', 'Connection cancelled');
        parsed = utils.parseKey(keyData, passphrase);
        attempts += 1;
      }
      if (parsed instanceof Error) throw new SshError('BAD_KEY', `Private key error: ${parsed.message}`);
      cfg.privateKey = keyData;
      if (passphrase) cfg.passphrase = passphrase;
    } else if (server.auth === 'agent') {
      const agent = this._agentPath();
      if (!agent) throw new SshError('NO_AGENT', 'No SSH agent found. Start ssh-agent (or Pageant on Windows) and add your key.');
      cfg.agent = agent;
    }
    // 'interactive' needs nothing up front: answers are prompted below.
    return cfg;
  }

  _agentPath() {
    const custom = this.store.getSettings().agentPath;
    if (custom) return custom;
    if (this.platform === 'win32') return this.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
    return this.env.SSH_AUTH_SOCK || '';
  }

  _label(server) {
    return { name: server.name, host: server.host, port: server.port, username: server.username };
  }

  async _handshake(server, sock) {
    const auth = await this._buildAuth(server);
    const storedPassword = auth._password;
    delete auth._password;

    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      // Our own login timeout, paused while the user answers a prompt.
      let timer = null;
      const startTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => done(new SshError('ETIMEDOUT', `Timed out connecting to ${server.host}:${server.port}.`)), this.readyTimeout);
      };
      const pauseTimer = () => clearTimeout(timer);
      const asking = (promise) => {
        pauseTimer();
        return promise.finally(() => { if (!settled) startTimer(); });
      };
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          client.end();
          reject(err);
        } else {
          resolve(client);
        }
      };

      client.on('ready', () => done());
      client.on('error', (err) => done(friendlyError(err, server)));
      client.on('close', () => done(new SshError('CLOSED', `Connection to ${server.host} closed during login.`)));

      let answeredStoredPassword = false;
      client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        if (!prompts || prompts.length === 0) return finish([]);
        // Answer a single password prompt with the saved password once.
        if (storedPassword && !answeredStoredPassword && prompts.length === 1 && /password/i.test(prompts[0].prompt)) {
          answeredStoredPassword = true;
          return finish([storedPassword]);
        }
        asking(this.prompt('keyboard-interactive', {
          server: this._label(server),
          name,
          instructions,
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: Boolean(p.echo) })),
        })).then((answers) => {
          if (!answers) {
            done(new SshError('CANCELLED', 'Connection cancelled'));
            return;
          }
          finish(answers);
        }, (err) => done(err));
      });

      const config = {
        host: server.host,
        port: server.port,
        username: server.username,
        readyTimeout: 0, // handled by our own timer above
        keepaliveInterval: server.keepAlive ? server.keepAlive * 1000 : 0,
        keepaliveCountMax: 3,
        tryKeyboard: true,
        hostVerifier: (key, verify) => {
          asking(this._verifyHost(server, key)).then((ok) => {
            if (!ok) done(new SshError('HOSTKEY_REJECTED', `Host key for ${server.host} was not trusted.`));
            verify(ok);
          }, (err) => {
            done(err);
            verify(false);
          });
        },
        ...auth,
      };
      if (server.agentForward && auth.agent) config.agentForward = true;
      if (sock) config.sock = sock;
      if (server.legacyAlgorithms) config.algorithms = LEGACY_ALGORITHMS;

      try {
        startTimer();
        client.connect(config);
      } catch (err) {
        done(friendlyError(err, server));
      }
    });
  }

  async _verifyHost(server, key) {
    const fingerprint = fingerprintOf(key);
    const type = keyTypeOf(key);
    const known = this.store.getKnownHost(server.host, server.port);
    if (known && known.fingerprint === fingerprint) return true;

    const answer = await this.prompt('hostkey', {
      server: this._label(server),
      type,
      fingerprint,
      changed: Boolean(known),
      previous: known ? known.fingerprint : null,
    });
    if (answer === true || answer === 'trust') {
      this.store.trustHost(server.host, server.port, { type, fingerprint });
      return true;
    }
    if (answer === 'once') return true;
    return false;
  }

  _client(serverId) {
    const entry = this.conns.get(serverId);
    if (!entry || !entry.ready) throw new SshError('NOT_CONNECTED', 'Not connected to this server.');
    return entry.client;
  }

  // ---- browser tunnel ----------------------------------------------------

  /**
   * Start (or reuse) a local SOCKS5 proxy on 127.0.0.1 whose connections are
   * opened from the server's side of the SSH connection. It stops when the
   * server disconnects. Resolves with the local port.
   */
  async startProxy(serverId) {
    this._client(serverId);
    if (!this.proxies.has(serverId)) {
      const p = startSocksServer(
        (host, port, srcPort) => this.forward(serverId, host, port, srcPort),
        { onError: (err, host, port) => this.emit('tunnel:error', { serverId, host, port, message: err.message }) },
      );
      this.proxies.set(serverId, p);
      p.catch(() => this.proxies.delete(serverId));
    }
    return (await this.proxies.get(serverId)).port;
  }

  stopProxy(serverId) {
    const p = this.proxies.get(serverId);
    if (!p) return;
    this.proxies.delete(serverId);
    p.then((proxy) => proxy.close(), () => {});
  }

  /** Open a TCP connection to host:port from the server (direct-tcpip). */
  forward(serverId, host, port, srcPort = 0) {
    return new Promise((resolve, reject) => {
      let client;
      try {
        client = this._client(serverId);
      } catch (err) {
        reject(err);
        return;
      }
      client.forwardOut('127.0.0.1', srcPort, host, port, (err, stream) => {
        if (err) {
          // RFC 4254 reasons: 1 prohibited, 2 connect failed, 4 resource shortage.
          const detail = err.message.replace(/^\(SSH\) Channel open failure:\s*/, '');
          let why;
          if (err.reason === 1 || /prohibited/i.test(detail)) {
            why = 'The server does not allow port forwarding. Set AllowTcpForwarding yes in /etc/ssh/sshd_config and restart sshd.';
          } else if (/not known|resolve|no address|nodename/i.test(detail)) {
            why = `The server could not find the address ${host}.`;
          } else if (err.reason === 2 || /refused|connect failed/i.test(detail)) {
            why = `Nothing is listening on ${host}:${port} as seen from the server. Check that the service is running and the port is right.`;
          } else if (err.reason === 4) {
            why = 'The server has too many open connections. Try again in a moment.';
          } else {
            why = detail || err.message;
          }
          reject(new SshError('FORWARD_FAILED', why));
        } else {
          resolve(stream);
        }
      });
    });
  }

  /** Listening TCP ports on the server, likely web interfaces first. */
  async listeningPorts(serverId) {
    const out = await this.capture(serverId, LIST_PORTS_COMMAND);
    return parseListeningPorts(out);
  }

  /** Run a command and return its stdout, without adding it to history. */
  capture(serverId, command) {
    const client = this._client(serverId);
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(friendlyError(err));
        const chunks = [];
        stream.on('data', (d) => chunks.push(d));
        stream.stderr.on('data', () => {});
        stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
    });
  }

  // ---- commands ----------------------------------------------------------

  /**
   * Run a command. Output streams through 'exec:data' events; resolves with
   * the exit info once the command finishes.
   */
  exec(serverId, command, { runId = crypto.randomUUID(), cwd = '', pty = false } = {}) {
    const client = this._client(serverId);
    const full = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
    const started = Date.now();
    this.store.addHistory(serverId, command);

    return new Promise((resolve, reject) => {
      const opts = pty ? { pty: { term: 'xterm-256color', cols: 200, rows: 50 } } : {};
      client.exec(full, opts, (err, stream) => {
        if (err) return reject(friendlyError(err));
        this.runs.set(runId, stream);
        const out = new StringDecoder('utf8');
        const errDec = new StringDecoder('utf8');
        let code = null;
        let signal = null;
        stream.on('data', (d) => this.emit('exec:data', { runId, stream: 'stdout', data: out.write(d) }));
        stream.stderr.on('data', (d) => this.emit('exec:data', { runId, stream: 'stderr', data: errDec.write(d) }));
        stream.on('exit', (c, s) => {
          code = c;
          signal = s || null;
        });
        stream.on('close', () => {
          const tailOut = out.end();
          const tailErr = errDec.end();
          if (tailOut) this.emit('exec:data', { runId, stream: 'stdout', data: tailOut });
          if (tailErr) this.emit('exec:data', { runId, stream: 'stderr', data: tailErr });
          this.runs.delete(runId);
          const info = { runId, code, signal, durationMs: Date.now() - started };
          this.emit('exec:exit', info);
          resolve(info);
        });
      });
    });
  }

  cancelExec(runId) {
    const stream = this.runs.get(runId);
    if (!stream) return false;
    try { stream.signal('INT'); } catch (_) { /* not all servers support signals */ }
    setTimeout(() => {
      if (this.runs.has(runId)) stream.close();
    }, 800);
    return true;
  }

  // ---- interactive shell -------------------------------------------------

  openShell(serverId, { cols = 80, rows = 24 } = {}) {
    const client = this._client(serverId);
    const server = this.store.getServer(serverId);
    const shellId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(friendlyError(err));
        const dec = new StringDecoder('utf8');
        this.shells.set(shellId, { stream, serverId });
        stream.on('data', (d) => this.emit('shell:data', { shellId, data: dec.write(d) }));
        stream.stderr.on('data', (d) => this.emit('shell:data', { shellId, data: d.toString('utf8') }));
        stream.on('close', () => {
          if (this.shells.delete(shellId)) this.emit('shell:exit', { shellId });
        });
        if (server && server.startDir) stream.write(`cd ${shellQuote(server.startDir)}\n`);
        resolve({ shellId });
      });
    });
  }

  writeShell(shellId, data) {
    const sh = this.shells.get(shellId);
    if (sh) sh.stream.write(data);
  }

  resizeShell(shellId, cols, rows) {
    const sh = this.shells.get(shellId);
    if (sh) sh.stream.setWindow(rows, cols, 0, 0);
  }

  closeShell(shellId) {
    const sh = this.shells.get(shellId);
    if (sh) {
      sh.stream.end();
      sh.stream.close();
    }
  }

  // ---- SFTP --------------------------------------------------------------

  async _sftp(serverId) {
    const entry = this.conns.get(serverId);
    const client = this._client(serverId);
    if (entry.sftp) return entry.sftp;
    entry.sftp = await new Promise((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(friendlyError(err)) : resolve(sftp)));
    });
    entry.sftp.on('close', () => { entry.sftp = null; });
    return entry.sftp;
  }

  async _ops(serverId) {
    const s = await this._sftp(serverId);
    return {
      raw: s,
      realpath: promisify(s.realpath, s),
      readdir: promisify(s.readdir, s),
      stat: promisify(s.stat, s),
      lstat: promisify(s.lstat, s),
      mkdir: promisify(s.mkdir, s),
      rmdir: promisify(s.rmdir, s),
      unlink: promisify(s.unlink, s),
      rename: promisify(s.rename, s),
      chmod: promisify(s.chmod, s),
      readFile: promisify(s.readFile, s),
      writeFile: promisify(s.writeFile, s),
      fastPut: promisify(s.fastPut, s),
      fastGet: promisify(s.fastGet, s),
      posixRename: (a, b) => new Promise((resolve, reject) => {
        try {
          s.ext_openssh_rename(a, b, (err) => (err ? reject(err) : resolve()));
        } catch (err) {
          reject(err);
        }
      }),
    };
  }

  async home(serverId) {
    const ops = await this._ops(serverId);
    const server = this.store.getServer(serverId);
    if (server && server.startDir) {
      try {
        const p = await ops.realpath(server.startDir);
        return p;
      } catch (_) { /* fall back to home */ }
    }
    return ops.realpath('.');
  }

  async list(serverId, dir) {
    const ops = await this._ops(serverId);
    const target = await ops.realpath(dir || '.');
    const items = await ops.readdir(target);
    const entries = await Promise.all(items.map(async (it) => {
      const mode = it.attrs.mode;
      let type = modeType(mode);
      let linkTarget = null;
      if (type === 'link') {
        try {
          const st = await ops.stat(posix.join(target, it.filename));
          linkTarget = modeType(st.mode);
        } catch (_) {
          linkTarget = 'broken';
        }
      }
      return {
        name: it.filename,
        path: posix.join(target, it.filename),
        type,
        linkTarget,
        size: it.attrs.size,
        mtime: it.attrs.mtime,
        mode: mode & 0o7777,
        uid: it.attrs.uid,
        gid: it.attrs.gid,
      };
    }));
    const isDir = (e) => e.type === 'dir' || (e.type === 'link' && e.linkTarget === 'dir');
    entries.sort((a, b) => (isDir(b) - isDir(a)) || a.name.localeCompare(b.name));
    return { path: target, entries };
  }

  /**
   * Find files and folders whose name contains `query` (any case) below
   * `dir`, using find on the server. Skips .git and node_modules.
   */
  async findFiles(serverId, dir, query, { maxDepth = 8, limit = 300 } = {}) {
    const q = String(query || '').trim();
    if (!q) return { dir, results: [], truncated: false };
    const pattern = `*${q.replace(/[\\*?[\]]/g, (c) => `\\${c}`)}*`;
    const find = (typeTest) => `$T find . -maxdepth ${maxDepth} \\( -name .git -o -name node_modules \\) -prune -o -iname ${shellQuote(pattern)} ${typeTest} -print 2>/dev/null | head -n ${limit + 1}`;
    const script = [
      `cd ${shellQuote(dir)} 2>/dev/null || { echo 'E cannot open folder'; exit 0; }`,
      "T=; command -v timeout >/dev/null 2>&1 && T='timeout 20'",
      `${find('-type d')} | sed 's/^/d /'`,
      `${find('! -type d')} | sed 's/^/f /'`,
    ].join('\n');
    const out = await this.capture(serverId, script);
    if (/^E cannot open folder/m.test(out)) throw new SshError('NOT_FOUND', `Cannot search ${dir}.`);
    const dirs = [];
    const files = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^([df]) \.\/(.+)$/);
      if (!m) continue;
      const rel = m[2];
      const entry = { name: posix.basename(rel), rel, path: posix.join(dir, rel), type: m[1] === 'd' ? 'dir' : 'file' };
      (m[1] === 'd' ? dirs : files).push(entry);
    }
    const truncated = dirs.length > limit || files.length > limit;
    const byPath = (a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel);
    const results = [...dirs.slice(0, limit).sort(byPath), ...files.slice(0, limit).sort(byPath)];
    return { dir, query: q, results, truncated };
  }

  async readFile(serverId, remotePath, { maxBytes = MAX_EDIT_BYTES } = {}) {
    const ops = await this._ops(serverId);
    const st = await ops.stat(remotePath);
    if (modeType(st.mode) === 'dir') throw new SshError('IS_DIR', 'That path is a folder.');
    if (st.size > maxBytes) throw new SshError('TOO_LARGE', `File is ${(st.size / 1048576).toFixed(1)} MB; the editor opens files up to ${(maxBytes / 1048576).toFixed(0)} MB. Download it instead.`);
    const buf = await ops.readFile(remotePath);
    if (looksBinary(buf)) throw new SshError('BINARY', 'This looks like a binary file. Download it instead.');
    return { path: remotePath, content: buf.toString('utf8'), size: st.size, mtime: st.mtime, mode: st.mode & 0o7777 };
  }

  /**
   * Save a text file. Pass expect = { mtime, size } from readFile to detect
   * changes made on the server since the file was opened.
   */
  async writeFile(serverId, remotePath, content, { expect = null, force = false } = {}) {
    const ops = await this._ops(serverId);
    let mode = null;
    try {
      const st = await ops.stat(remotePath);
      mode = st.mode & 0o7777;
      if (expect && !force && (st.mtime !== expect.mtime || st.size !== expect.size)) {
        throw new SshError('CONFLICT', 'This file changed on the server after you opened it.');
      }
    } catch (err) {
      if (err instanceof SshError) throw err;
      // File does not exist yet: create it.
    }

    const data = Buffer.from(content, 'utf8');
    const dir = posix.dirname(remotePath);
    const tmp = posix.join(dir, `.${posix.basename(remotePath)}.hostdeck-${crypto.randomBytes(4).toString('hex')}`);
    const entry = this.conns.get(serverId);
    let atomic = false;
    if (!entry.noAtomicRename) {
      try {
        await ops.writeFile(tmp, data);
        if (mode !== null) await ops.chmod(tmp, mode);
        await ops.posixRename(tmp, remotePath);
        atomic = true;
      } catch (err) {
        if (/not support/i.test(err.message)) entry.noAtomicRename = true;
        try { await ops.unlink(tmp); } catch (_e) { /* tmp may not exist */ }
      }
    }
    if (!atomic) {
      // Server lacks atomic rename (or tmp could not be created): write in place.
      await ops.writeFile(remotePath, data);
    }
    const st = await ops.stat(remotePath);
    return { path: remotePath, size: st.size, mtime: st.mtime, mode: st.mode & 0o7777 };
  }

  async mkdir(serverId, remotePath) {
    const ops = await this._ops(serverId);
    await ops.mkdir(remotePath);
  }

  async rename(serverId, from, to) {
    const ops = await this._ops(serverId);
    await ops.rename(from, to);
  }

  async chmod(serverId, remotePath, mode) {
    const ops = await this._ops(serverId);
    await ops.chmod(remotePath, typeof mode === 'string' ? parseInt(mode, 8) : mode);
  }

  async remove(serverId, remotePath) {
    const ops = await this._ops(serverId);
    const rm = async (p) => {
      const st = await ops.lstat(p);
      if (modeType(st.mode) === 'dir') {
        const items = await ops.readdir(p);
        for (const it of items) await rm(posix.join(p, it.filename));
        await ops.rmdir(p);
      } else {
        await ops.unlink(p);
      }
    };
    await rm(remotePath);
  }

  /** Upload local files or folders into a remote folder. */
  async upload(serverId, localPaths, remoteDir, { transferId = crypto.randomUUID() } = {}) {
    const ops = await this._ops(serverId);
    const jobs = [];
    const walk = (local, remote) => {
      const st = fs.statSync(local);
      if (st.isDirectory()) {
        jobs.push({ kind: 'dir', remote });
        for (const name of fs.readdirSync(local)) walk(path.join(local, name), posix.join(remote, name));
      } else if (st.isFile()) {
        jobs.push({ kind: 'file', local, remote, size: st.size });
      }
    };
    for (const p of localPaths) walk(p, posix.join(remoteDir, path.basename(p)));

    const total = jobs.reduce((n, j) => n + (j.size || 0), 0);
    let doneBytes = 0;
    for (const job of jobs) {
      if (job.kind === 'dir') {
        try { await ops.mkdir(job.remote); } catch (_) { /* may exist */ }
        continue;
      }
      const base = doneBytes;
      await ops.fastPut(job.local, job.remote, {
        step: (transferred) => this.emit('transfer', { transferId, file: job.remote, transferred: base + transferred, total }),
      });
      doneBytes += job.size;
      this.emit('transfer', { transferId, file: job.remote, transferred: doneBytes, total });
    }
    this.emit('transfer', { transferId, transferred: total, total, done: true });
    return { transferId, files: jobs.filter((j) => j.kind === 'file').length, bytes: total };
  }

  /** Download a remote file or folder to a local path. */
  async download(serverId, remotePath, localPath, { transferId = crypto.randomUUID() } = {}) {
    const ops = await this._ops(serverId);
    const jobs = [];
    const walk = async (remote, local) => {
      const st = await ops.stat(remote);
      if (modeType(st.mode) === 'dir') {
        jobs.push({ kind: 'dir', local });
        for (const it of await ops.readdir(remote)) await walk(posix.join(remote, it.filename), path.join(local, it.filename));
      } else {
        jobs.push({ kind: 'file', remote, local, size: st.size });
      }
    };
    await walk(remotePath, localPath);
    const total = jobs.reduce((n, j) => n + (j.size || 0), 0);
    let doneBytes = 0;
    for (const job of jobs) {
      if (job.kind === 'dir') {
        fs.mkdirSync(job.local, { recursive: true });
        continue;
      }
      const base = doneBytes;
      await ops.fastGet(job.remote, job.local, {
        step: (transferred) => this.emit('transfer', { transferId, file: job.remote, transferred: base + transferred, total }),
      });
      doneBytes += job.size;
    }
    this.emit('transfer', { transferId, transferred: total, total, done: true });
    return { transferId, files: jobs.filter((j) => j.kind === 'file').length, bytes: total };
  }
}

module.exports = { SshManager, SshError, fingerprintOf, shellQuote, friendlyError };
