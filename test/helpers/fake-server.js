// A small but real SSH server for tests, built on ssh2's server API.
// It runs commands with the local shell, serves SFTP from a sandbox folder
// (virtual "/" maps to the sandbox root, home is /home) and supports
// port forwarding so jump hosts can be tested.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Server, utils } = require('ssh2');

const { STATUS_CODE, flagsToString } = utils.sftp;

function attrsOf(st) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.root sandbox folder for SFTP
 * @param {{username:string,password?:string,publicKey?:string,otp?:string}} opts.user
 * @param {string} [opts.hostKey] PEM/OpenSSH private host key
 */
function startServer({ root, user, hostKey, port = 0 }) {
  const key = hostKey || require('./env').generateKeys().private;
  const allowedKey = user.publicKey ? utils.parseKey(user.publicKey) : null;
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });

  const toReal = (vpath) => {
    let p = vpath || '.';
    if (!p.startsWith('/')) p = path.posix.join('/home', p);
    p = path.posix.normalize(p);
    return path.join(root, p);
  };
  const toVirtual = (vpath) => {
    let p = vpath || '.';
    if (!p.startsWith('/')) p = path.posix.join('/home', p);
    return path.posix.normalize(p);
  };

  const clients = new Set();
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.username !== user.username) return ctx.reject();
      if (ctx.method === 'password' && user.password && !user.otp) {
        return ctx.password === user.password ? ctx.accept() : ctx.reject();
      }
      if (ctx.method === 'publickey' && allowedKey) {
        if (ctx.key.algo !== allowedKey.type || !ctx.key.data.equals(allowedKey.getPublicSSH())) return ctx.reject();
        if (ctx.signature && allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
        return ctx.accept();
      }
      if (ctx.method === 'keyboard-interactive' && user.password) {
        const prompts = [{ prompt: 'Password: ', echo: false }];
        if (user.otp) prompts.push({ prompt: 'Verification code: ', echo: true });
        return ctx.prompt(prompts, 'Login', '', (answers) => {
          const ok = answers[0] === user.password && (!user.otp || answers[1] === user.otp);
          return ok ? ctx.accept() : ctx.reject();
        });
      }
      const methods = [];
      if (user.password) methods.push(user.otp ? 'keyboard-interactive' : 'password', 'keyboard-interactive');
      if (allowedKey) methods.push('publickey');
      return ctx.reject(methods);
    });

    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP);
        sock.once('connect', () => {
          const stream = accept();
          stream.pipe(sock).pipe(stream);
        });
        sock.once('error', () => reject());
      });

      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept) => accept && accept());
        session.on('window-change', (accept) => accept && accept());
        session.on('env', (accept) => accept && accept());
        session.on('signal', (accept, reject, info) => {
          if (accept) accept();
          if (session._child) session._child.kill(`SIG${info.name}`);
        });

        session.on('exec', (accept, reject, info) => {
          const stream = accept();
          const child = spawn('sh', ['-c', info.command], { cwd: path.join(root, 'home') });
          session._child = child;
          child.stdout.on('data', (d) => stream.write(d));
          child.stderr.on('data', (d) => stream.stderr.write(d));
          stream.on('data', (d) => child.stdin.write(d));
          stream.on('close', () => child.kill());
          child.on('close', (code, signal) => {
            if (signal) stream.exit(signal, false, '');
            else stream.exit(code ?? 0);
            stream.end();
          });
        });

        session.on('shell', (accept) => {
          const stream = accept();
          // Use a real pseudo-terminal (via util-linux "script") when available,
          // so input echo and Enter behave like a real SSH server.
          // util-linux "script" only; the BSD version on macOS takes different arguments.
          const usePty = process.platform === 'linux'
            && (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, 'script')));
          const child = usePty
            ? spawn('script', ['-qfc', 'sh -i', '/dev/null'], { cwd: path.join(root, 'home'), env: { ...process.env, TERM: 'xterm-256color', PS1: '$ ' } })
            : spawn('sh', [], { cwd: path.join(root, 'home') });
          child.stdout.on('data', (d) => stream.write(d));
          child.stderr.on('data', (d) => stream.stderr.write(d));
          stream.on('data', (d) => child.stdin.write(d));
          stream.on('close', () => child.kill());
          child.on('close', (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });

        session.on('sftp', (accept) => {
          const sftp = accept();
          const handles = new Map();
          let next = 0;
          const newHandle = (value) => {
            const id = next++;
            handles.set(id, value);
            const b = Buffer.alloc(4);
            b.writeUInt32BE(id);
            return b;
          };
          const getHandle = (buf) => handles.get(buf.readUInt32BE(0));
          const fail = (reqid, err) => sftp.status(reqid, err && err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, err ? err.message : '');
          const ok = (reqid) => sftp.status(reqid, STATUS_CODE.OK);

          sftp.on('OPEN', (reqid, filename, flags) => {
            try {
              const fd = fs.openSync(toReal(filename), flagsToString(flags));
              sftp.handle(reqid, newHandle({ fd }));
            } catch (err) { fail(reqid, err); }
          });
          sftp.on('READ', (reqid, handle, offset, length) => {
            const h = getHandle(handle);
            if (!h || h.fd === undefined) return fail(reqid);
            const buf = Buffer.alloc(length);
            const n = fs.readSync(h.fd, buf, 0, length, offset);
            if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            return sftp.data(reqid, buf.subarray(0, n));
          });
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const h = getHandle(handle);
            if (!h || h.fd === undefined) return fail(reqid);
            fs.writeSync(h.fd, data, 0, data.length, offset);
            return ok(reqid);
          });
          sftp.on('CLOSE', (reqid, handle) => {
            const id = handle.readUInt32BE(0);
            const h = handles.get(id);
            if (h && h.fd !== undefined) fs.closeSync(h.fd);
            handles.delete(id);
            ok(reqid);
          });
          sftp.on('FSTAT', (reqid, handle) => {
            const h = getHandle(handle);
            try { sftp.attrs(reqid, attrsOf(fs.fstatSync(h.fd))); } catch (err) { fail(reqid, err); }
          });
          sftp.on('FSETSTAT', (reqid, handle, attrs) => {
            const h = getHandle(handle);
            try {
              if (attrs.mode !== undefined) fs.fchmodSync(h.fd, attrs.mode & 0o7777);
              ok(reqid);
            } catch (err) { fail(reqid, err); }
          });
          const statHandler = (useL) => (reqid, p) => {
            try { sftp.attrs(reqid, attrsOf((useL ? fs.lstatSync : fs.statSync)(toReal(p)))); } catch (err) { fail(reqid, err); }
          };
          sftp.on('STAT', statHandler(false));
          sftp.on('LSTAT', statHandler(true));
          sftp.on('SETSTAT', (reqid, p, attrs) => {
            try {
              if (attrs.mode !== undefined) fs.chmodSync(toReal(p), attrs.mode & 0o7777);
              ok(reqid);
            } catch (err) { fail(reqid, err); }
          });
          sftp.on('OPENDIR', (reqid, p) => {
            try {
              const real = toReal(p);
              if (!fs.statSync(real).isDirectory()) throw new Error('not a dir');
              sftp.handle(reqid, newHandle({ dir: real, done: false }));
            } catch (err) { fail(reqid, err); }
          });
          sftp.on('READDIR', (reqid, handle) => {
            const h = getHandle(handle);
            if (!h || h.done) return sftp.status(reqid, STATUS_CODE.EOF);
            h.done = true;
            const names = fs.readdirSync(h.dir).map((name) => {
              const st = fs.lstatSync(path.join(h.dir, name));
              return { filename: name, longname: name, attrs: attrsOf(st) };
            });
            if (names.length === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            return sftp.name(reqid, names);
          });
          sftp.on('REALPATH', (reqid, p) => {
            const v = toVirtual(p);
            if (!fs.existsSync(toReal(v))) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            return sftp.name(reqid, [{ filename: v, longname: v, attrs: {} }]);
          });
          sftp.on('MKDIR', (reqid, p) => { try { fs.mkdirSync(toReal(p)); ok(reqid); } catch (err) { fail(reqid, err); } });
          sftp.on('RMDIR', (reqid, p) => { try { fs.rmdirSync(toReal(p)); ok(reqid); } catch (err) { fail(reqid, err); } });
          sftp.on('REMOVE', (reqid, p) => { try { fs.unlinkSync(toReal(p)); ok(reqid); } catch (err) { fail(reqid, err); } });
          sftp.on('RENAME', (reqid, a, b) => {
            try {
              if (fs.existsSync(toReal(b))) throw new Error('target exists');
              fs.renameSync(toReal(a), toReal(b));
              ok(reqid);
            } catch (err) { fail(reqid, err); }
          });
        });
      });
    });
    client.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((r) => {
          for (const c of clients) c.end();
          server.close(() => r());
        }),
      });
    });
  });
}

module.exports = { startServer };
