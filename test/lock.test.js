const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { AppLock } = require('../src/main/lock');
const { makeStore } = require('./helpers/env');

test('a PIN is stored only as a hash, and starts the app locked', async () => {
  const { store, dir } = makeStore();
  const lock = new AppLock(store);
  assert.deepEqual(lock.status(), { enabled: false, locked: false, waitSeconds: 0 });
  assert.throws(() => lock.setPin('12'), /4 to 12 digits/);
  assert.throws(() => lock.setPin('12ab'), /4 to 12 digits/);
  lock.setPin('482913');
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('482913'));

  const next = new AppLock(new (require('../src/main/store').Store)({ dir, cipher: store.cipher }));
  assert.equal(next.status().locked, true, 'a new start is locked');
  assert.equal(next.unlock('000000').ok, false);
  assert.equal(next.unlock('482913').ok, true);
  assert.equal(next.status().locked, false);
});

test('changing or removing the PIN needs the current one', () => {
  const { store } = makeStore();
  const lock = new AppLock(store);
  lock.setPin('1111');
  assert.throws(() => lock.setPin('2222', '9999'), /current PIN/);
  lock.setPin('2222', '1111');
  assert.throws(() => lock.disable('1111'), /current PIN/);
  lock.disable('2222');
  assert.equal(lock.enabled, false);
});

test('wrong PINs slow down after five tries', () => {
  const { store } = makeStore();
  let t = 1000000;
  const lock = new AppLock(store, { now: () => t });
  lock.setPin('1234');
  lock.lock();
  for (let i = 1; i <= 4; i += 1) {
    const r = lock.unlock('0000');
    assert.equal(r.ok, false);
    assert.equal(r.attemptsLeft, 5 - i);
    assert.equal(r.waitSeconds, 0);
  }
  const fifth = lock.unlock('0000');
  assert.equal(fifth.waitSeconds, 30);
  assert.equal(lock.unlock('1234').ok, false, 'even the right PIN waits');
  t += 30000;
  assert.equal(lock.unlock('0000').waitSeconds, 60, 'the wait doubles');
  t += 60000;
  assert.equal(lock.unlock('1234').ok, true);
});

test('forgotten PIN: reset removes the lock and every secret but keeps servers', async () => {
  const { store } = makeStore();
  const s = await store.upsertServer({ host: 'a.example', password: 'pw', auth: 'password' });
  await store.saveLogin(s.id, 'http://localhost:8080', 'admin', 'secret');
  const lock = new AppLock(store);
  lock.setPin('5555');
  lock.lock();
  lock.reset();
  assert.equal(lock.status().locked, false);
  assert.equal(lock.enabled, false);
  assert.equal(store.listServers().length, 1);
  assert.equal(store.getServer(s.id).hasPassword, false);
  assert.deepEqual(store.allLogins(), []);
});

test('browser logins are encrypted, updated per username and removed with the server', async () => {
  const { store } = makeStore();
  const s = await store.upsertServer({ name: 'web', host: 'w.example' });
  const site = 'http://localhost:8080';
  const a = await store.saveLogin(s.id, site, 'root', 'hunter2-db');
  await store.saveLogin(s.id, site, 'root', 'changed-pw');
  await store.saveLogin(s.id, site, 'readonly', 'ro-pass');
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('changed-pw'));
  assert.deepEqual(store.listLogins(s.id, site).map((l) => l.username), ['root', 'readonly']);
  assert.equal(await store.getLoginPassword(s.id, site, a.id), 'changed-pw');
  assert.equal(await store.hasLogin(s.id, site, 'root', 'changed-pw'), true);
  assert.equal(await store.hasLogin(s.id, site, 'root', 'other'), false);
  assert.deepEqual(store.listLogins(s.id, 'http://localhost:5050'), []);
  await assert.rejects(store.saveLogin(s.id, 'javascript:alert(1)', 'x', 'y'), /Invalid site/);

  store.neverSaveFor(s.id, 'http://localhost:9000');
  assert.equal(store.isNeverSave(s.id, 'http://localhost:9000'), true);
  assert.ok(!JSON.stringify(store.exportData()).includes('localhost:8080'), 'exports leave logins out');

  store.deleteLogin(s.id, site, a.id);
  assert.deepEqual(store.listLogins(s.id, site).map((l) => l.username), ['readonly']);
  store.deleteServer(s.id);
  assert.deepEqual(store.allLogins(), []);
});
