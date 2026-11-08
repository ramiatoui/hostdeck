// Minimal OpenSSH client config (~/.ssh/config) reader used to import hosts.
// Supports Host blocks with HostName, User, Port, IdentityFile and ProxyJump.
// Wildcard-only patterns (like "Host *") provide defaults but are not imported.
const fs = require('fs');
const os = require('os');
const path = require('path');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseSshConfig(text) {
  const blocks = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s*(?:=\s*|\s+)(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key === 'host') {
      current = { patterns: value.split(/\s+/), options: {} };
      blocks.push(current);
    } else if (key === 'match') {
      current = null; // Match blocks are not supported; skip their options.
    } else if (current && current.options[key] === undefined) {
      current.options[key] = value;
    }
  }

  const isWildcard = (p) => /[*?!]/.test(p);
  const globToRegex = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  const matches = (patterns, alias) => {
    let hit = false;
    for (const p of patterns) {
      if (p.startsWith('!')) {
        if (globToRegex(p.slice(1)).test(alias)) return false;
      } else if (globToRegex(p).test(alias)) {
        hit = true;
      }
    }
    return hit;
  };

  const seen = new Set();
  const hosts = [];
  for (const b of blocks) {
    for (const alias of b.patterns) {
      if (isWildcard(alias) || seen.has(alias)) continue;
      seen.add(alias);
      // Like OpenSSH: walk blocks in order, the first value found wins.
      const o = {};
      for (const blk of blocks) {
        if (!matches(blk.patterns, alias)) continue;
        for (const [k, v] of Object.entries(blk.options)) if (o[k] === undefined) o[k] = v;
      }
      hosts.push({
        alias,
        host: o.hostname || alias,
        port: o.port ? parseInt(o.port, 10) : 22,
        username: o.user || '',
        keyPath: o.identityfile ? expandHome(o.identityfile) : '',
        proxyJump: o.proxyjump && o.proxyjump.toLowerCase() !== 'none' ? o.proxyjump : '',
      });
    }
  }
  return hosts;
}

function readDefaultSshConfig() {
  const file = path.join(os.homedir(), '.ssh', 'config');
  try {
    return { file, hosts: parseSshConfig(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return { file, hosts: [] };
    throw err;
  }
}

module.exports = { parseSshConfig, readDefaultSshConfig, expandHome };
