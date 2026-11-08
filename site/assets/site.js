// Landing page: platform-aware download button and the in-browser demo.
(function () {
  // ---- download button for the visitor's platform
  const ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
  const os = /mac/i.test(ua) ? 'mac' : /win/i.test(ua) ? 'windows' : /linux|x11|cros/i.test(ua) ? 'linux' : null;
  const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };
  const cta = document.getElementById('cta-download');
  if (os && cta && !/android|iphone|ipad/i.test(navigator.userAgent)) {
    cta.querySelector('span').textContent = `Download for ${names[os]}`;
    const card = document.querySelector(`.dl[data-os="${os}"]`);
    if (card) {
      card.classList.add('mine');
      card.querySelector('.btn').classList.add('primary');
    }
  }

  // ---- demo
  const out = document.getElementById('demo-out');
  if (!out) return;
  const form = document.getElementById('demo-form');
  const input = document.getElementById('demo-cmd');
  const runBtn = document.getElementById('demo-run');
  const status = document.getElementById('demo-status');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const hosts = {
    web: { name: 'web-1', addr: 'ubuntu@51.15.204.18', cmd: 'df -h /', connected: false },
    api: { name: 'api (EC2)', addr: 'ec2-user@3.120.45.10', cmd: 'docker ps', connected: false },
    db: { name: 'postgres', addr: 'postgres@10.0.1.20 via bastion', cmd: 'systemctl status postgresql', connected: false },
  };
  let current = 'web';

  const outputs = {
    'df -h /': () => [['', 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        38G   14G   23G  38% /\n']],
    uptime: () => [['', ' 21:14:03 up 41 days,  3:02,  0 users,  load average: 0.08, 0.11, 0.09\n']],
    'free -h': () => [['', '               total        used        free      shared  buff/cache   available\nMem:           3.8Gi       1.1Gi       412Mi        12Mi       2.3Gi       2.5Gi\nSwap:             0B          0B          0B\n']],
    'docker ps': () => [['', 'CONTAINER ID   IMAGE              STATUS        PORTS                  NAMES\n3f1c2a9d8b7e   acme/api:2.4.1     Up 6 days     0.0.0.0:3000->3000/tcp api\n9e8d7c6b5a41   redis:7-alpine     Up 6 days     6379/tcp               cache\n']],
    'systemctl status postgresql': () => [['ok', '● '], ['', 'postgresql.service - PostgreSQL RDBMS\n     Loaded: loaded (/lib/systemd/system/postgresql.service; enabled)\n     Active: '], ['ok', 'active (exited)'], ['', ' since Mon 2026-10-26 08:12:44 UTC\n']],
    whoami: () => [['', `${hosts[current].addr.split('@')[0]}\n`]],
  };

  function select(key) {
    current = key;
    const h = hosts[key];
    document.querySelectorAll('.demo-host').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.host === key)));
    document.getElementById('demo-name').textContent = h.name;
    document.getElementById('demo-addr').textContent = h.addr;
    status.textContent = h.connected ? 'Connected' : 'Not connected';
    status.classList.toggle('on', h.connected);
    input.value = h.cmd;
    out.innerHTML = '<span class="dim">Press Run to see what happens.</span>';
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  function line(cls, text) {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    out.append(s);
    out.scrollTop = out.scrollHeight;
  }

  async function run(e) {
    e.preventDefault();
    const cmd = input.value.trim();
    if (!cmd) return;
    const h = hosts[current];
    runBtn.disabled = true;
    out.textContent = '';
    line('amb', '$ ');
    line('', `${cmd}\n`);
    if (!h.connected) {
      status.textContent = 'Connecting…';
      await wait(500);
      h.connected = true;
      status.textContent = 'Connected';
      status.classList.add('on');
    }
    const started = performance.now();
    await wait(250);
    const parts = outputs[cmd] ? outputs[cmd]() : [['err', `This demo only knows a few commands. Try: ${Object.keys(outputs).join(', ')}\n`]];
    for (const [cls, text] of parts) {
      line(cls, text);
      await wait(60);
    }
    const code = outputs[cmd] ? 0 : 127;
    line(code === 0 ? 'ok' : 'err', `\nExit ${code}`);
    line('dim', `  ${Math.max(84, Math.round(performance.now() - started))} ms`);
    runBtn.disabled = false;
  }

  document.querySelectorAll('.demo-host').forEach((b) => b.addEventListener('click', () => select(b.dataset.host)));
  form.addEventListener('submit', run);
})();
