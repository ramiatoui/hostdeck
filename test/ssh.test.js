const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SshManager } = require('../src/main/ssh');
const { startServer } = require('./helpers/fake-server');
const { makeStore, tempDir, generateKeys } = require('./helpers/env');

function setup({ user, answers = {} } = {}) {
  const { store } = makeStore();
  const prompts = [];
  const prompt = async (kind, payload) => {
    prompts.push({ kind, payload });
    const a = answers[kind];
    return typeof a === 'function' ? a(payload) : a;
  };
  const ssh = new SshManager({ store, prompt, env: {} });
  return { store, ssh, prompts, user };
}

function collect(ssh, runId) {
  const out = { stdout: '', stderr: '' };
  ssh.on('exec:data', (e) => { if (e.runId === runId) out[e.stream] += e.data; });
  return out;
}

test('password login, host key trust on first use, commands, cwd and exit codes', async (t) => {
  const root = tempDir();
  const srv = await startServer({ root, user: { username: 'deploy', password: 's3cret' } });
  t.after(() => srv.close());
  const { store, ssh, prompts } = setup({ answers: { hostkey: 'trust' } });
  t.after(() => ssh.disconnectAll());

  const s = await store.upsertServer({ name: 'local', host: '127.0.0.1', port: srv.port, username: 'deploy', auth: 'password', password: 's3cret' });
  await ssh.connect(s.id);
  assert.equal(prompts.filter((p) => p.kind === 'hostkey').length, 1);
  assert.match(prompts[0].payload.fingerprint, /^SHA256:/);
  assert.equal(prompts[0].payload.changed, false);
  assert.ok(ssh.isConnected(s.id));

  const out = collect(ssh, 'r1');
  const res = await ssh.exec(s.id, 'echo hello; echo oops 1>&2; exit 3', { runId: 'r1' });
  assert.equal(out.stdout.trim(), 'hello');
  assert.equal(out.stderr.trim(), 'oops');
  assert.equal(res.code, 3);

  const out2 = collect(ssh, 'r2');
  // Run in a folder; on Windows the test server's shell uses its own path style.
  const workDir = tempDir();
  const shellDir = process.platform === 'win32' ? '/' : workDir;
  await ssh.exec(s.id, 'pwd -P', { runId: 'r2', cwd: shellDir });
  if (process.platform !== 'win32') assert.equal(out2.stdout.trim(), fs.realpathSync(workDir));
  else assert.equal(out2.stdout.trim(), '/');
  assert.deepEqual(store.getHistory(s.id).slice(0, 2), ['pwd -P', 'echo hello; echo oops 1>&2; exit 3']);

  // Reconnecting a known host does not prompt again.
  ssh.disconnect(s.id);
  await ssh.connect(s.id);
  assert.equal(prompts.filter((p) => p.kind === 'hostkey').length, 1);
});

test('a changed host key is reported and rejected by default', async (t) => {
  const root = tempDir();
  const srv = await startServer({ root, user: { username: 'u', password: 'p' } });
  t.after(() => srv.close());
  const { store, ssh, prompts } = setup({ answers: { hostkey: null } });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' });
  store.trustHost('127.0.0.1', srv.port, { type: 'ssh-ed25519', fingerprint: 'SHA256:old' });

  await assert.rejects(ssh.connect(s.id), (err) => err.code === 'HOSTKEY_REJECTED');
  assert.equal(prompts[0].payload.changed, true);
  assert.equal(prompts[0].payload.previous, 'SHA256:old');
  assert.ok(!ssh.isConnected(s.id));
});

test('wrong password gives a clear error', async (t) => {
  const srv = await startServer({ root: tempDir(), user: { username: 'u', password: 'right' } });
  t.after(() => srv.close());
  const { store, ssh } = setup({ answers: { hostkey: 'once', 'keyboard-interactive': null } });
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'wrong' });
  await assert.rejects(ssh.connect(s.id), (err) => /Authentication failed|cancelled/i.test(err.message));
});

test('asks for the password when set to "ask every time"', async (t) => {
  const srv = await startServer({ root: tempDir(), user: { username: 'u', password: 'typed' } });
  t.after(() => srv.close());
  const { store, ssh, prompts } = setup({ answers: { hostkey: 'once', password: 'typed' } });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', auth: 'password', askPassword: true });
  await ssh.connect(s.id);
  assert.ok(prompts.some((p) => p.kind === 'password'));
});

test('keyboard-interactive login with a one-time code (2FA)', async (t) => {
  const srv = await startServer({ root: tempDir(), user: { username: 'u', password: 'pw', otp: '123456' } });
  t.after(() => srv.close());
  const { store, ssh, prompts } = setup({
    answers: {
      hostkey: 'once',
      'keyboard-interactive': (p) => p.prompts.map((q) => (/code/i.test(q.prompt) ? '123456' : 'pw')),
    },
  });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', auth: 'interactive' });
  await ssh.connect(s.id);
  const kbd = prompts.find((p) => p.kind === 'keyboard-interactive');
  assert.equal(kbd.payload.prompts.length, 2);
  assert.equal(kbd.payload.prompts[1].echo, true);
});

test('private key login with a passphrase prompt', async (t) => {
  const keys = generateKeys({ passphrase: 'open sesame', cipher: 'aes256-ctr', rounds: 4 });
  const srv = await startServer({ root: tempDir(), user: { username: 'u', publicKey: keys.public } });
  t.after(() => srv.close());
  const keyFile = path.join(tempDir(), 'id_ed25519');
  fs.writeFileSync(keyFile, keys.private);

  const { store, ssh, prompts } = setup({ answers: { hostkey: 'once', passphrase: 'open sesame' } });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', auth: 'key', keyPath: keyFile });
  await ssh.connect(s.id);
  assert.ok(prompts.some((p) => p.kind === 'passphrase'));
  assert.ok(ssh.isConnected(s.id));
});

test('pasted private key without passphrase', async (t) => {
  const keys = generateKeys();
  const srv = await startServer({ root: tempDir(), user: { username: 'u', publicKey: keys.public } });
  t.after(() => srv.close());
  const { store, ssh } = setup({ answers: { hostkey: 'once' } });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', auth: 'key', keyText: keys.private });
  await ssh.connect(s.id);
  assert.ok(ssh.isConnected(s.id));
});

test('connects through a jump host', async (t) => {
  const bastion = await startServer({ root: tempDir(), user: { username: 'jump', password: 'jp' } });
  const inner = await startServer({ root: tempDir(), user: { username: 'app', password: 'ap' } });
  t.after(() => bastion.close());
  t.after(() => inner.close());
  const { store, ssh, prompts } = setup({ answers: { hostkey: 'trust' } });
  t.after(() => ssh.disconnectAll());

  const j = await store.upsertServer({ name: 'bastion', host: '127.0.0.1', port: bastion.port, username: 'jump', password: 'jp' });
  const s = await store.upsertServer({ name: 'app', host: '127.0.0.1', port: inner.port, username: 'app', password: 'ap', jumpId: j.id });
  await ssh.connect(s.id);
  assert.equal(prompts.filter((p) => p.kind === 'hostkey').length, 2, 'both hosts are verified');
  const out = collect(ssh, 'jr');
  await ssh.exec(s.id, 'echo through-the-jump', { runId: 'jr' });
  assert.equal(out.stdout.trim(), 'through-the-jump');
});

test('interactive shell session', async (t) => {
  const srv = await startServer({ root: tempDir(), user: { username: 'u', password: 'p' } });
  t.after(() => srv.close());
  const { store, ssh } = setup({ answers: { hostkey: 'once' } });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' });
  await ssh.connect(s.id);
  const { shellId } = await ssh.openShell(s.id, { cols: 100, rows: 30 });
  let output = '';
  const got = new Promise((resolve) => {
    ssh.on('shell:data', (e) => {
      if (e.shellId !== shellId) return;
      output += e.data;
      if (output.includes('shell-ok-42')) resolve();
    });
  });
  ssh.writeShell(shellId, 'echo shell-ok-$((40+2))\n');
  await got;
  ssh.resizeShell(shellId, 120, 40);
  const exited = new Promise((resolve) => ssh.on('shell:exit', (e) => e.shellId === shellId && resolve()));
  ssh.writeShell(shellId, 'exit\n');
  await exited;
});

test('SFTP: browse, edit with conflict check, upload, download, rename, delete', async (t) => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'home', 'site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'site', 'index.html'), '<h1>hi</h1>\n');
  fs.writeFileSync(path.join(root, 'home', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
  const srv = await startServer({ root, user: { username: 'u', password: 'p' } });
  t.after(() => srv.close());
  const { store, ssh } = setup({ answers: { hostkey: 'once' } });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' });
  await ssh.connect(s.id);

  const home = await ssh.home(s.id);
  assert.equal(home, '/home');
  const listing = await ssh.list(s.id, home);
  assert.equal(listing.entries[0].name, 'site', 'folders are listed first');
  assert.equal(listing.entries[0].type, 'dir');

  const file = await ssh.readFile(s.id, '/home/site/index.html');
  assert.equal(file.content, '<h1>hi</h1>\n');
  await assert.rejects(ssh.readFile(s.id, '/home/blob.bin'), (e) => e.code === 'BINARY');

  const saved = await ssh.writeFile(s.id, file.path, '<h1>hello</h1>\n', { expect: { mtime: file.mtime, size: file.size } });
  assert.equal(fs.readFileSync(path.join(root, 'home', 'site', 'index.html'), 'utf8'), '<h1>hello</h1>\n');
  assert.equal(saved.size, 15);
  assert.ok(!fs.readdirSync(path.join(root, 'home', 'site')).some((n) => n.includes('hostdeck')), 'no temp files left behind');

  // Someone else changes the file: saving with the old version is refused.
  fs.writeFileSync(path.join(root, 'home', 'site', 'index.html'), 'changed elsewhere, longer content\n');
  await assert.rejects(
    ssh.writeFile(s.id, file.path, 'mine', { expect: { mtime: saved.mtime, size: saved.size } }),
    (e) => e.code === 'CONFLICT',
  );
  await ssh.writeFile(s.id, file.path, 'mine', { expect: { mtime: saved.mtime, size: saved.size }, force: true });
  assert.equal(fs.readFileSync(path.join(root, 'home', 'site', 'index.html'), 'utf8'), 'mine');

  // New file
  await ssh.writeFile(s.id, '/home/new.conf', 'a=1\n');
  assert.equal(fs.readFileSync(path.join(root, 'home', 'new.conf'), 'utf8'), 'a=1\n');

  // Upload a folder with progress
  const local = tempDir();
  fs.mkdirSync(path.join(local, 'assets', 'img'), { recursive: true });
  fs.writeFileSync(path.join(local, 'assets', 'app.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(local, 'assets', 'img', 'big.dat'), Buffer.alloc(300000, 7));
  const progress = [];
  ssh.on('transfer', (e) => progress.push(e));
  const up = await ssh.upload(s.id, [path.join(local, 'assets')], '/home/site');
  assert.equal(up.files, 2);
  assert.ok(progress.some((p) => p.done));
  assert.equal(fs.statSync(path.join(root, 'home', 'site', 'assets', 'img', 'big.dat')).size, 300000);

  // Download it back
  const dl = path.join(tempDir(), 'copy');
  await ssh.download(s.id, '/home/site/assets', dl);
  assert.equal(fs.readFileSync(path.join(dl, 'app.js'), 'utf8'), 'console.log(1)\n');

  await ssh.mkdir(s.id, '/home/backup');
  await ssh.rename(s.id, '/home/new.conf', '/home/backup/new.conf');
  assert.ok(fs.existsSync(path.join(root, 'home', 'backup', 'new.conf')));
  await ssh.chmod(s.id, '/home/backup/new.conf', '600');
  if (process.platform !== 'win32') {
    // Windows has no Unix permission bits.
    assert.equal(fs.statSync(path.join(root, 'home', 'backup', 'new.conf')).mode & 0o777, 0o600);
  }

  await ssh.remove(s.id, '/home/site');
  assert.ok(!fs.existsSync(path.join(root, 'home', 'site')));
});

test('friendly error for a closed port', async () => {
  const { store, ssh } = setup({ answers: {} });
  const s = await store.upsertServer({ host: '127.0.0.1', port: 1, username: 'u', auth: 'agent' });
  store.updateSettings({ agentPath: '/nonexistent.sock' });
  await assert.rejects(ssh.connect(s.id), (e) => /refused|agent/i.test(e.message));
});

test('time spent answering prompts does not count toward the login timeout', async (t) => {
  const srv = await startServer({ root: tempDir(), user: { username: 'u', password: 'p' } });
  t.after(() => srv.close());
  const slow = () => new Promise((r) => setTimeout(() => r('trust'), 700));
  const { store, ssh } = setup({ answers: { hostkey: slow } });
  t.after(() => ssh.disconnectAll());
  ssh.readyTimeout = 400;
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' });
  await ssh.connect(s.id);
  assert.ok(ssh.isConnected(s.id));
});

test('an unresponsive host times out', async (t) => {
  const net = require('net');
  const socks = new Set();
  const silent = net.createServer((sock) => socks.add(sock)); // accepts TCP but never speaks SSH
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  t.after(() => { for (const sk of socks) sk.destroy(); silent.close(); });
  const { store, ssh } = setup({ answers: {} });
  ssh.readyTimeout = 300;
  const s = await store.upsertServer({ host: '127.0.0.1', port: silent.address().port, username: 'u', auth: 'interactive' });
  await assert.rejects(ssh.connect(s.id), (e) => e.code === 'ETIMEDOUT');
});
