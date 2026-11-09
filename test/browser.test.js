const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const { SshManager } = require('../src/main/ssh');
const { parseListeningPorts } = require('../src/main/ports');
const { startServer } = require('./helpers/fake-server');
const { makeStore, tempDir } = require('./helpers/env');

// Connect through a SOCKS5 proxy and send a raw HTTP request.
function socksGet(proxyPort, { host, ipv4, port, path = '/' }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    let stage = 0;
    let buf = Buffer.alloc(0);
    sock.on('error', reject);
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        assert.deepEqual([...buf.subarray(0, 2)], [5, 0]);
        buf = buf.subarray(2);
        stage = 1;
        const p = Buffer.alloc(2);
        p.writeUInt16BE(port);
        const addr = ipv4
          ? Buffer.from([1, ...ipv4.split('.').map(Number)])
          : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, p]));
      }
      if (stage === 1 && buf.length >= 10) {
        const code = buf[1];
        buf = buf.subarray(10);
        if (code !== 0) { sock.destroy(); resolve({ socksReply: code }); return; }
        stage = 2;
        sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host || ipv4}:${port}\r\nConnection: close\r\n\r\n`);
      }
    });
    sock.on('end', () => {
      if (stage === 2) resolve({ socksReply: 0, body: buf.toString('utf8') });
    });
  });
}

async function setup(t) {
  const srv = await startServer({ root: tempDir(), user: { username: 'u', password: 'p' } });
  t.after(() => srv.close());
  const { store } = makeStore();
  const ssh = new SshManager({ store, prompt: async () => 'once', env: {} });
  t.after(() => ssh.disconnectAll());
  const s = await store.upsertServer({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' });
  await ssh.connect(s.id);
  return { ssh, id: s.id };
}

// Stands in for something like phpMyAdmin bound to the server's localhost.
async function webApp(t) {
  const app = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end(`admin panel at ${req.url}`);
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  return app.address().port;
}

test('browser proxy reaches the server\'s localhost by name and by IP', async (t) => {
  const { ssh, id } = await setup(t);
  const appPort = await webApp(t);
  const proxyPort = await ssh.startProxy(id);
  assert.equal(await ssh.startProxy(id), proxyPort, 'the proxy is reused');

  const byName = await socksGet(proxyPort, { host: 'localhost', port: appPort, path: '/phpmyadmin/' });
  assert.equal(byName.socksReply, 0);
  assert.match(byName.body, /200 OK/);
  assert.match(byName.body, /admin panel at \/phpmyadmin\//);

  const byIp = await socksGet(proxyPort, { ipv4: '127.0.0.1', port: appPort });
  assert.match(byIp.body, /admin panel at \//);
});

test('a closed port is refused cleanly and reported', async (t) => {
  const { ssh, id } = await setup(t);
  const closed = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
  const errors = [];
  ssh.on('tunnel:error', (e) => errors.push(e));
  const proxyPort = await ssh.startProxy(id);
  const res = await socksGet(proxyPort, { host: 'localhost', port: closed });
  assert.notEqual(res.socksReply, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].port, closed);
  assert.match(errors[0].message, /Nothing is listening on localhost:\d+/);
});

test('the proxy stops when the server disconnects', async (t) => {
  const { ssh, id } = await setup(t);
  const proxyPort = await ssh.startProxy(id);
  ssh.disconnect(id);
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => { s.destroy(); resolve(); });
    s.on('error', reject);
  }));
  await assert.rejects(ssh.startProxy(id), (e) => e.code === 'NOT_CONNECTED');
});

test('capture returns output without adding to history', async (t) => {
  const { ssh, id } = await setup(t);
  assert.equal((await ssh.capture(id, 'echo hi')).trim(), 'hi');
  assert.deepEqual(ssh.store.getHistory(id), []);
});

test('finds listening web ports from ss and netstat output', () => {
  const ss = `LISTEN 0      4096       127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      511        127.0.0.1:8080       0.0.0.0:*
LISTEN 0      4096         0.0.0.0:5050       0.0.0.0:*
LISTEN 0      4096            [::]:5050          [::]:*
LISTEN 0      80         127.0.0.1:3306       0.0.0.0:*
LISTEN 0      511         10.0.1.5:9090       0.0.0.0:*
LISTEN 0      511                *:80               *:*`;
  assert.deepEqual(parseListeningPorts(ss), [
    { host: 'localhost', port: 80 },
    { host: 'localhost', port: 5050 },
    { host: 'localhost', port: 8080 },
    { host: '10.0.1.5', port: 9090 },
  ]);
  const netstat = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State
tcp        0      0 127.0.0.1:8080          0.0.0.0:*               LISTEN
tcp6       0      0 :::3000                 :::*                    LISTEN`;
  assert.deepEqual(parseListeningPorts(netstat), [
    { host: 'localhost', port: 3000 },
    { host: 'localhost', port: 8080 },
  ]);
});
