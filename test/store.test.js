const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { makeStore } = require('./helpers/env');
const { parseSshConfig } = require('../src/main/sshconfig');

test('secrets are encrypted on disk and kept, replaced or cleared on update', () => {
  const { store } = makeStore();
  const s = store.upsertServer({ name: 'web', host: 'example.org', username: 'ubuntu', auth: 'password', password: 'hunter2-super-secret' });
  assert.equal(s.hasPassword, true);
  assert.equal(s.password, undefined, 'public view never exposes secrets');

  const raw = fs.readFileSync(store.file, 'utf8');
  assert.ok(!raw.includes('hunter2-super-secret'), 'password must not be stored in plain text');
  assert.equal(store.getServer(s.id, { withSecrets: true }).password, 'hunter2-super-secret');

  store.upsertServer({ id: s.id, host: 'example.org', name: 'web2' });
  assert.equal(store.getServer(s.id, { withSecrets: true }).password, 'hunter2-super-secret', 'undefined keeps the secret');

  store.upsertServer({ id: s.id, host: 'example.org', password: '' });
  assert.equal(store.getServer(s.id).hasPassword, false, 'empty string clears the secret');
});

test('file is private to the user', { skip: process.platform === 'win32' }, () => {
  const { store } = makeStore();
  store.upsertServer({ host: 'a.example' });
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('refuses to store secrets without secure storage', () => {
  const { store } = makeStore({ available: false });
  assert.throws(() => store.upsertServer({ host: 'x', password: 'p' }), /Secure storage is not available/);
  assert.doesNotThrow(() => store.upsertServer({ host: 'x', auth: 'password', askPassword: true }));
});

test('export leaves secrets out and import re-links jump hosts', () => {
  const { store } = makeStore();
  const bastion = store.upsertServer({ name: 'bastion', host: 'b.example', password: 'pw' });
  store.upsertServer({ name: 'db', host: '10.0.0.5', jumpId: bastion.id, auth: 'agent' });
  store.upsertSnippet({ name: 'disk', command: 'df -h' });

  const exported = store.exportData();
  assert.ok(!JSON.stringify(exported).includes('secrets'));

  const { store: other } = makeStore();
  const res = other.importData(exported);
  assert.equal(res.added, 2);
  const servers = other.listServers();
  const b2 = servers.find((x) => x.name === 'bastion');
  const db2 = servers.find((x) => x.name === 'db');
  assert.equal(db2.jumpId, b2.id);
  assert.equal(b2.hasPassword, false);
  assert.equal(other.listSnippets()[0].command, 'df -h');
});

test('history keeps the newest unique commands first', () => {
  const { store } = makeStore();
  store.addHistory('s1', 'uptime');
  store.addHistory('s1', 'df -h');
  store.addHistory('s1', 'uptime');
  assert.deepEqual(store.getHistory('s1'), ['uptime', 'df -h']);
});

test('deleting a jump host unlinks servers that used it', () => {
  const { store } = makeStore();
  const j = store.upsertServer({ host: 'jump' });
  const t = store.upsertServer({ host: 'target', jumpId: j.id });
  store.deleteServer(j.id);
  assert.equal(store.getServer(t.id).jumpId, '');
});

test('parses ~/.ssh/config hosts with defaults and ProxyJump', () => {
  const hosts = parseSshConfig(`
# production
Host web prod-web
  HostName 51.15.1.2
  Port 2222

Host db
  HostName 10.0.0.5
  User postgres
  ProxyJump web

Match host foo
  User nobody

Host *
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
`);
  assert.equal(hosts.length, 3);
  const web = hosts.find((h) => h.alias === 'web');
  assert.equal(web.host, '51.15.1.2');
  assert.equal(web.port, 2222);
  assert.equal(web.username, 'ubuntu');
  assert.ok(web.keyPath.endsWith('.ssh/id_ed25519') || web.keyPath.endsWith('.ssh\\id_ed25519'));
  const db = hosts.find((h) => h.alias === 'db');
  assert.equal(db.username, 'postgres');
  assert.equal(db.proxyJump, 'web');
});
