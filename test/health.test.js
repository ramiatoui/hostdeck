const test = require('node:test');
const assert = require('node:assert');
const { parseHealth, hasHealth, HEALTH_COMMAND } = require('../src/main/health');
const { SshManager } = require('../src/main/ssh');
const { startServer } = require('./helpers/fake-server');
const { makeStore, tempDir } = require('./helpers/env');

const SEP = '@@hostdeck@@';
const sample = (parts) => parts.join(`\n${SEP}\n`);

test('parses Linux health output', () => {
  const h = parseHealth(sample([
    '3546123.52 7012345.10',
    '0.08 0.11 0.09 1/234 5678',
    '2',
    'MemTotal:        3984588 kB\nMemFree:          421888 kB\nMemAvailable:    2621440 kB\nBuffers:          102400 kB\nCached:          1900000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB',
    '/dev/sda1         39845888  14680064  23068672      39% /',
  ]));
  assert.equal(h.uptimeSec, 3546123);
  assert.deepEqual(h.load, [0.08, 0.11, 0.09]);
  assert.equal(h.cpus, 2);
  assert.equal(h.memory.total, 3984588 * 1024);
  assert.equal(h.memory.available, 2621440 * 1024);
  assert.equal(h.memory.percent, 34);
  assert.deepEqual(h.swap, { total: 0, used: 0, percent: 0 });
  assert.equal(h.disk.mount, '/');
  assert.equal(h.disk.percent, 39);
  assert.equal(h.disk.available, 23068672 * 1024);
  assert.ok(hasHealth(h));
});

test('estimates available memory on kernels without MemAvailable', () => {
  const h = parseHealth(sample(['', '', '', 'MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 100 kB\nCached: 300 kB\nSwapTotal: 500 kB\nSwapFree: 400 kB', '']));
  assert.equal(h.memory.available, 600 * 1024);
  assert.equal(h.memory.percent, 40);
  assert.equal(h.swap.percent, 20);
  assert.equal(h.disk, null);
});

test('unknown systems give empty health instead of failing', () => {
  const h = parseHealth('% Invalid input detected at marker\n');
  assert.equal(hasHealth(h), false);
  assert.equal(h.load, null);
});

test('reads health from a real shell over SSH', { skip: process.platform !== 'linux' }, async (t) => {
  const srv = await startServer({ root: tempDir(), user: { username: 'u', password: 'p' } });
  t.after(() => srv.close());
  const { store } = makeStore();
  const ssh = new SshManager({ store, prompt: async () => 'once', env: {} });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' });
  await ssh.connect(s.id);
  const h = await ssh.health(s.id);
  assert.ok(h.uptimeSec > 0);
  assert.equal(h.load.length, 3);
  assert.ok(h.memory.total > 0 && h.memory.percent >= 0 && h.memory.percent <= 100);
  assert.ok(h.cpus >= 1);
  assert.deepEqual(store.getHistory(s.id), [], 'health checks are not added to history');
  assert.ok(HEALTH_COMMAND.includes('/proc/meminfo'));
});
