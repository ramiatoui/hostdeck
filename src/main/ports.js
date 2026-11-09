// Turns `ss -ltn` / `netstat -ltn` output into the TCP ports a server is
// listening on, so the browser can suggest them.

// Ports that almost never speak HTTP; hidden from suggestions.
const NOT_WEB = new Set([22, 25, 53, 110, 111, 143, 465, 587, 631, 993, 995, 2049, 3306, 5432, 6379, 11211, 27017, 33060]);

function splitHostPort(addr) {
  const i = addr.lastIndexOf(':');
  if (i < 0) return null;
  let host = addr.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const port = parseInt(addr.slice(i + 1), 10);
  if (!Number.isFinite(port)) return null;
  if (host === '*' || host === '0.0.0.0' || host === '::' || host === '' || host === '127.0.0.1' || host === '::1' || /^127\./.test(host)) host = 'localhost';
  return { host, port };
}

function parseListeningPorts(output) {
  const seen = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    let local = null;
    if (cols[0] === 'LISTEN' && cols.length >= 4) local = cols[3]; // ss -ltn(H)
    else if (/^tcp6?$/.test(cols[0]) && cols[cols.length - 1] === 'LISTEN') local = cols[3]; // netstat -ltn
    if (!local) continue;
    const hp = splitHostPort(local);
    if (!hp || NOT_WEB.has(hp.port)) continue;
    const key = `${hp.host}:${hp.port}`;
    if (!seen.has(key)) seen.set(key, hp);
  }
  // If a port is open on all interfaces and on a specific address, keep localhost.
  const list = [...seen.values()].filter((p) => p.host === 'localhost' || !seen.has(`localhost:${p.port}`));
  return list.sort((a, b) => a.port - b.port || a.host.localeCompare(b.host));
}

const LIST_PORTS_COMMAND = 'ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null';

module.exports = { parseListeningPorts, LIST_PORTS_COMMAND };
