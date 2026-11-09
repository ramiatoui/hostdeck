// Quick server health: uptime, load, memory and root disk usage, read in one
// command. Works on Linux; other systems simply return fewer fields.

const SEP = '@@hostdeck@@';

const HEALTH_COMMAND = [
  'cat /proc/uptime 2>/dev/null',
  `echo '${SEP}'`,
  'cat /proc/loadavg 2>/dev/null',
  `echo '${SEP}'`,
  'nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null',
  `echo '${SEP}'`,
  "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
  `echo '${SEP}'`,
  'df -Pk / 2>/dev/null | tail -n 1',
].join('; ');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function parseHealth(output) {
  const parts = String(output || '').split(SEP).map((p) => p.trim());
  const [uptimeRaw = '', loadRaw = '', cpuRaw = '', memRaw = '', diskRaw = ''] = parts;
  const health = { uptimeSec: null, load: null, cpus: null, memory: null, swap: null, disk: null };

  const up = num(uptimeRaw.split(/\s+/)[0]);
  if (up !== null && up >= 0) health.uptimeSec = Math.floor(up);

  const loads = loadRaw.split(/\s+/).slice(0, 3).map(num);
  if (loads.length === 3 && loads.every((n) => n !== null)) health.load = loads;

  const cpus = parseInt(cpuRaw, 10);
  if (cpus > 0) health.cpus = cpus;

  const mem = {};
  for (const line of memRaw.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  if (mem.MemTotal) {
    // Older kernels lack MemAvailable; approximate it like free(1) used to.
    const available = mem.MemAvailable !== undefined
      ? mem.MemAvailable
      : (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0) + (mem.SReclaimable || 0);
    const total = mem.MemTotal;
    const used = Math.max(0, total - Math.min(available, total));
    health.memory = { total, used, available: Math.min(available, total), percent: Math.round((used / total) * 100) };
    if (mem.SwapTotal) {
      const swapUsed = Math.max(0, mem.SwapTotal - (mem.SwapFree || 0));
      health.swap = { total: mem.SwapTotal, used: swapUsed, percent: Math.round((swapUsed / mem.SwapTotal) * 100) };
    } else if (mem.SwapTotal === 0) {
      health.swap = { total: 0, used: 0, percent: 0 };
    }
  }

  // df -Pk: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const d = diskRaw.split(/\s+/);
  if (d.length >= 6) {
    const total = num(d[1]);
    const used = num(d[2]);
    const avail = num(d[3]);
    if (total && used !== null && avail !== null) {
      // Same rounding as df: used / (used + available).
      const percent = Math.ceil((used / (used + avail || 1)) * 100);
      health.disk = { mount: d.slice(5).join(' '), total: total * 1024, used: used * 1024, available: avail * 1024, percent };
    }
  }
  return health;
}

function hasHealth(h) {
  return Boolean(h && (h.uptimeSec !== null || h.load || h.memory || h.disk));
}

module.exports = { HEALTH_COMMAND, parseHealth, hasHealth };
