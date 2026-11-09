// Minimal SOCKS5 server (RFC 1928, CONNECT only, no auth) that hands every
// connection to a callback. Hostdeck points its built-in browser at it, and
// the callback opens the connection from the SSH server's side, like ssh -D.
const net = require('net');

const REPLY = {
  OK: 0x00,
  FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  NET_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  REFUSED: 0x05,
  CMD_UNSUPPORTED: 0x07,
  ATYP_UNSUPPORTED: 0x08,
};

function reply(sock, code) {
  // Bound address is not meaningful here; send 0.0.0.0:0.
  sock.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
}

function ipv6ToString(buf) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/** Parse a CONNECT request. Returns null if more bytes are needed. */
function parseRequest(buf) {
  if (buf.length < 5) return null;
  const [ver, cmd, , atyp] = buf;
  if (ver !== 0x05) return { error: REPLY.FAILURE };
  let host;
  let offset;
  if (atyp === 0x01) {
    if (buf.length < 10) return null;
    host = [...buf.subarray(4, 8)].join('.');
    offset = 8;
  } else if (atyp === 0x03) {
    const len = buf[4];
    if (buf.length < 5 + len + 2) return null;
    host = buf.subarray(5, 5 + len).toString('utf8');
    offset = 5 + len;
  } else if (atyp === 0x04) {
    if (buf.length < 22) return null;
    host = ipv6ToString(buf.subarray(4, 20));
    offset = 20;
  } else {
    return { error: REPLY.ATYP_UNSUPPORTED };
  }
  if (cmd !== 0x01) return { error: REPLY.CMD_UNSUPPORTED };
  const port = buf.readUInt16BE(offset);
  return { host, port, rest: buf.subarray(offset + 2) };
}

function codeForError(err) {
  const msg = String((err && err.message) || '');
  if (/prohibited|not permitted|denied/i.test(msg)) return REPLY.NOT_ALLOWED;
  if (/refused/i.test(msg)) return REPLY.REFUSED;
  if (/resolve|not known|no such host|unreachable/i.test(msg)) return REPLY.HOST_UNREACHABLE;
  return REPLY.FAILURE;
}

/**
 * @param {(host:string, port:number, srcPort:number) => Promise<import('stream').Duplex>} openStream
 * @returns {Promise<{port:number, close():Promise<void>, server:net.Server}>}
 */
function startSocksServer(openStream, { onError } = {}) {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setNoDelay(true);
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    const fail = (code) => {
      if (!sock.destroyed) {
        reply(sock, code);
        sock.end();
      }
    };
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf[0] !== 0x05) { sock.destroy(); return; }
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0x00)) {
          sock.end(Buffer.from([0x05, 0xff]));
          return;
        }
        sock.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        const req = parseRequest(buf);
        if (!req) return;
        if (req.error) { fail(req.error); return; }
        stage = 'connecting';
        sock.removeListener('data', onData);
        sock.pause();
        openStream(req.host, req.port, sock.remotePort || 0).then((stream) => {
          if (sock.destroyed) { stream.destroy(); return; }
          reply(sock, REPLY.OK);
          if (req.rest.length) stream.write(req.rest);
          stream.on('error', () => sock.destroy());
          sock.on('error', () => stream.destroy());
          stream.on('close', () => sock.destroy());
          sock.on('close', () => stream.destroy());
          sock.pipe(stream).pipe(sock);
          sock.resume();
        }, (err) => {
          if (onError) onError(err, req.host, req.port);
          fail(codeForError(err));
        });
      }
    };
    sock.on('data', onData);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

module.exports = { startSocksServer, parseRequest };
