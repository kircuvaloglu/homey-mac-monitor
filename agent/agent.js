#!/usr/bin/env node
'use strict';
/**
 * homey-mac-agent: local HTTP service that exposes Mac sensor data to Homey.
 *
 * Readings are collected in the background and /status returns the latest
 * snapshot. The macOS update check is slow, so it runs on its own schedule.
 * Actions come from a fixed table; request data is never passed to a shell.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const CONFIG_PATH = process.env.HOMEY_MAC_AGENT_CONFIG || '/usr/local/etc/homey-mac-agent/config.json';
const HERE = __dirname;

// Config

const DEFAULTS = {
  port: 8787,
  token: '',
  pollSeconds: 10,
  updateCheckHours: 6,
  // Restart and shutdown are disabled unless enabled in config.json.
  allowActions: {
    sleep: true,
    displaysleep: true,
    lock: true,
    notify: true,
    restart: false,
    shutdown: false
  },
  // Optional named scripts, e.g. { "backup": "/Users/x/bin/backup.sh" }.
  commands: {},
  // Empty allows all private networks; otherwise only these addresses.
  allowedIPs: [],
  advertiseBonjour: true
};

function loadConfig() {
  let cfg = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfg = { ...cfg, ...raw, allowActions: { ...DEFAULTS.allowActions, ...(raw.allowActions || {}) } };
  } catch (err) {
    if (err.code !== 'ENOENT') log('could not read config: ' + err.message);
  }
  return cfg;
}

let config = loadConfig();

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// Helpers

function sh(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? null : String(stdout || ''));
    });
  });
}

const num = (v) => (Number.isFinite(v) ? v : null);
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// Collectors

// os.cpus() returns cumulative ticks, so usage is the delta between two samples.
let lastCpuSample = null;
function cpuUsagePercent() {
  const now = os.cpus().reduce(
    (acc, c) => {
      for (const k of Object.keys(c.times)) acc[k] = (acc[k] || 0) + c.times[k];
      return acc;
    },
    {}
  );
  let pct = null;
  if (lastCpuSample) {
    const totalDelta = Object.keys(now).reduce((s, k) => s + (now[k] - (lastCpuSample[k] || 0)), 0);
    const idleDelta = now.idle - lastCpuSample.idle;
    if (totalDelta > 0) pct = round(((totalDelta - idleDelta) / totalDelta) * 100);
  }
  lastCpuSample = now;
  return pct;
}

async function readSensors() {
  const bin = path.join(HERE, 'macsensors');
  if (!fs.existsSync(bin)) return { ok: false, error: 'macsensors not found' };
  const out = await sh(bin, [], 5000);
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, error: 'could not parse macsensors output' };
  }
}

async function readMemory() {
  const pageSize = 16384; // default; vm_stat reports the actual page size
  const out = await sh('/usr/bin/vm_stat', [], 5000);
  if (!out) return null;
  const m = {};
  const psMatch = out.match(/page size of (\d+) bytes/);
  const ps = psMatch ? parseInt(psMatch[1], 10) : pageSize;
  for (const line of out.split('\n')) {
    const mm = line.match(/^(.+?):\s+(\d+)\./);
    if (mm) m[mm[1].trim()] = parseInt(mm[2], 10) * ps;
  }
  const total = os.totalmem();
  // Used memory as shown by Activity Monitor: active + wired + compressed.
  const used =
    (m['Pages active'] || 0) + (m['Pages wired down'] || 0) + (m['Pages occupied by compressor'] || 0);
  const swapOut = await sh('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], 3000);
  let swapUsedMB = null;
  if (swapOut) {
    const s = swapOut.match(/used\s*=\s*([\d.]+)M/);
    if (s) swapUsedMB = parseFloat(s[1]);
  }
  return {
    totalGB: round(total / 1024 ** 3),
    usedGB: round(used / 1024 ** 3),
    percent: round((used / total) * 100),
    cachedGB: round((m['Pages purgeable'] || 0) / 1024 ** 3),
    compressedGB: round((m['Pages occupied by compressor'] || 0) / 1024 ** 3),
    swapUsedMB: num(swapUsedMB)
  };
}

async function readDisks() {
  const out = await sh('/bin/df', ['-k'], 5000);
  if (!out) return null;
  const vols = [];
  for (const line of out.split('\n').slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 9 || !p[0].startsWith('/dev/')) continue;
    const mount = p.slice(8).join(' ');
    // Skip the system snapshot and helper volumes.
    if (mount !== '/' && !mount.startsWith('/System/Volumes/Data') && !mount.startsWith('/Volumes/')) continue;
    const totalGB = round(parseInt(p[1], 10) / 1024 ** 2);
    const freeGB = round(parseInt(p[3], 10) / 1024 ** 2);
    vols.push({
      mount,
      device: p[0],
      totalGB,
      freeGB,
      usedGB: round(totalGB - freeGB),
      percent: totalGB > 0 ? round(((totalGB - freeGB) / totalGB) * 100) : null
    });
  }
  // The Data volume holds user data; fall back to the root volume.
  const main = vols.find((v) => v.mount.startsWith('/System/Volumes/Data')) || vols.find((v) => v.mount === '/');
  return { main: main || null, volumes: vols };
}

// os.networkInterfaces() can return 02:00:00:00:00:00 on macOS, so the real
// hardware addresses are read from ifconfig.
const ANON_MAC = '02:00:00:00:00:00';
let macByInterface = {};

async function readMacAddresses() {
  const out = await sh('/sbin/ifconfig', ['-a'], 5000);
  if (!out) return macByInterface;
  const map = {};
  let current = null;
  for (const line of out.split('\n')) {
    const head = line.match(/^([a-z0-9]+):\s/i);
    if (head) { current = head[1]; continue; }
    const ether = line.match(/^\s+ether\s+([0-9a-f:]{17})/i);
    if (ether && current) map[current] = ether[1].toLowerCase();
  }
  macByInterface = map;
  return map;
}

function readNetwork() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.internal || a.family !== 'IPv4') continue;
      const mac = (!a.mac || a.mac === ANON_MAC) ? (macByInterface[name] || a.mac || null) : a.mac;
      list.push({ interface: name, ip: a.address, mac, netmask: a.netmask });
    }
  }
  return list;
}

async function readPrimaryInterface() {
  const out = await sh('/sbin/route', ['-n', 'get', 'default'], 3000);
  if (!out) return null;
  const m = out.match(/interface:\s*(\S+)/);
  return m ? m[1] : null;
}

async function readBattery() {
  const out = await sh('/usr/bin/pmset', ['-g', 'batt'], 4000);
  if (!out || !out.includes('InternalBattery')) return null;
  const pct = out.match(/(\d+)%/);
  const state = out.match(/;\s*([^;]+);/);
  return {
    percent: pct ? parseInt(pct[1], 10) : null,
    state: state ? state[1].trim() : null,
    onACPower: out.includes("'AC Power'")
  };
}

async function readThermalPressure() {
  const out = await sh('/usr/bin/pmset', ['-g', 'therm'], 4000);
  if (!out) return null;
  const m = out.match(/CPU_Scheduler_Limit\s*=\s*(\d+)/);
  const speed = out.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  return {
    schedulerLimit: m ? parseInt(m[1], 10) : null,
    speedLimit: speed ? parseInt(speed[1], 10) : null,
    // 100 means no throttling.
    throttled: speed ? parseInt(speed[1], 10) < 100 : false
  };
}

async function readTopProcesses() {
  const out = await sh('/bin/ps', ['-Aceo', 'pcpu,pmem,comm', '-r'], 4000);
  if (!out) return [];
  return out
    .split('\n')
    .slice(1, 6)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 3)
    .map((p) => ({ cpu: parseFloat(p[0]), mem: parseFloat(p[1]), name: p.slice(2).join(' ') }))
    .filter((p) => Number.isFinite(p.cpu));
}

// Static system info, refreshed at startup and with each update check.
let staticInfo = null;
async function readStaticInfo() {
  const [model, serialRaw, osName, osVersion, build, computerName, cpuBrand, memGB] = await Promise.all([
    sh('/usr/sbin/sysctl', ['-n', 'hw.model'], 3000),
    sh('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], 5000),
    sh('/usr/bin/sw_vers', ['-productName'], 3000),
    sh('/usr/bin/sw_vers', ['-productVersion'], 3000),
    sh('/usr/bin/sw_vers', ['-buildVersion'], 3000),
    sh('/usr/sbin/scutil', ['--get', 'ComputerName'], 3000),
    sh('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], 3000),
    sh('/usr/sbin/sysctl', ['-n', 'hw.memsize'], 3000)
  ]);
  await readMacAddresses().catch(() => {});
  let serial = null;
  if (serialRaw) {
    const m = serialRaw.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
    if (m) serial = m[1];
  }
  staticInfo = {
    computerName: (computerName || os.hostname()).trim(),
    hostname: os.hostname(),
    model: (model || '').trim() || null,
    serial,
    cpu: (cpuBrand || '').trim() || null,
    cores: os.cpus().length,
    memoryGB: memGB ? round(parseInt(memGB, 10) / 1024 ** 3, 0) : null,
    os: `${(osName || 'macOS').trim()} ${(osVersion || '').trim()}`,
    osVersion: (osVersion || '').trim(),
    build: (build || '').trim(),
    arch: os.arch()
  };
  return staticInfo;
}

// softwareupdate contacts Apple and takes a while, so results are cached.
let updateCache = { checkedAt: null, count: 0, items: [], restartRequired: false, error: null };
let updateCheckRunning = false;

async function checkUpdates() {
  if (updateCheckRunning) return updateCache;
  updateCheckRunning = true;
  try {
    const out = await sh('/usr/sbin/softwareupdate', ['-l'], 120000);
    const items = [];
    let restartRequired = false;
    if (out) {
      const lines = out.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const label = lines[i].match(/^\s*\*\s*Label:\s*(.+)$/);
        if (!label) continue;
        const detail = (lines[i + 1] || '').trim();
        const titleMatch = detail.match(/Title:\s*([^,]+)/);
        const versionMatch = detail.match(/Version:\s*([^,]+)/);
        const sizeMatch = detail.match(/Size:\s*([^,]+)/);
        if (/restart/i.test(detail)) restartRequired = true;
        items.push({
          label: label[1].trim(),
          title: titleMatch ? titleMatch[1].trim() : label[1].trim(),
          version: versionMatch ? versionMatch[1].trim() : null,
          size: sizeMatch ? sizeMatch[1].trim() : null,
          restartRequired: /restart/i.test(detail)
        });
      }
    }
    updateCache = {
      checkedAt: new Date().toISOString(),
      count: items.length,
      items,
      restartRequired,
      error: out === null ? 'softwareupdate failed' : null
    };
    log(`update check: ${items.length} available`);
  } finally {
    updateCheckRunning = false;
  }
  return updateCache;
}

// Snapshot

let snapshot = { ready: false };

async function refreshSnapshot() {
  const [sensors, memory, disks, battery, thermal, top, primaryIface] = await Promise.all([
    readSensors(),
    readMemory(),
    readDisks(),
    readBattery(),
    readThermalPressure(),
    readTopProcesses(),
    readPrimaryInterface()
  ]);

  const interfaces = readNetwork();
  const primary = interfaces.find((i) => i.interface === primaryIface) || interfaces[0] || null;

  snapshot = {
    ready: true,
    agentVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(os.uptime()),
    bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    system: staticInfo || (await readStaticInfo()),
    cpu: {
      usagePercent: cpuUsagePercent(),
      loadAverage: os.loadavg().map((v) => round(v, 2)),
      load1PerCore: round(os.loadavg()[0] / os.cpus().length, 2),
      temperature: sensors.ok ? sensors.cpu ?? null : null,
      temperatureMax: sensors.ok ? sensors.cpuMax ?? null : null
    },
    gpu: { temperature: sensors.ok ? sensors.gpu ?? null : null },
    thermal: {
      ...(thermal || {}),
      fanRpm: sensors.ok ? sensors.fanRpm ?? null : null,
      fanPercent: sensors.ok ? sensors.fanPercent ?? null : null,
      fans: sensors.ok ? sensors.fans ?? [] : [],
      powerWatts: sensors.ok ? sensors.powerWatts ?? null : null,
      sensorsAvailable: !!sensors.ok
    },
    memory,
    disk: disks ? disks.main : null,
    volumes: disks ? disks.volumes : [],
    network: { primary, interfaces },
    battery,
    topProcesses: top,
    updates: updateCache,
    actionsEnabled: Object.entries(config.allowActions)
      .filter(([, v]) => v)
      .map(([k]) => k),
    commandsAvailable: Object.keys(config.commands || {})
  };
}

// Actions

async function consoleUser() {
  const out = await sh('/usr/bin/stat', ['-f%Su', '/dev/console'], 3000);
  return out ? out.trim() : null;
}
async function consoleUID() {
  const user = await consoleUser();
  if (!user || user === 'root') return null;
  const out = await sh('/usr/bin/id', ['-u', user], 3000);
  return out ? out.trim() : null;
}

// The action name from a request is only used to look up an entry here.
const ACTIONS = {
  sleep: async () => sh('/usr/bin/pmset', ['sleepnow'], 5000),
  displaysleep: async () => sh('/usr/bin/pmset', ['displaysleepnow'], 5000),
  lock: async () => {
    const uid = await consoleUID();
    if (!uid) return null;
    return sh('/bin/launchctl', ['asuser', uid, '/usr/bin/open', '-a', 'ScreenSaverEngine'], 5000);
  },
  restart: async () => {
    setTimeout(() => execFile('/sbin/shutdown', ['-r', 'now']), 500);
    return 'restarting';
  },
  shutdown: async () => {
    setTimeout(() => execFile('/sbin/shutdown', ['-h', 'now']), 500);
    return 'shutting down';
  },
  notify: async (params) => {
    const uid = await consoleUID();
    if (!uid) return null;
    // Quotes and backslashes are removed so the text cannot break out of the AppleScript string.
    const title = String(params.title || 'Homey').replace(/["\\]/g, '');
    const message = String(params.message || '').replace(/["\\]/g, '');
    return sh(
      '/bin/launchctl',
      ['asuser', uid, '/usr/bin/osascript', '-e', `display notification "${message}" with title "${title}"`],
      5000
    );
  }
};

async function runAction(name, params) {
  if (name === 'command') {
    const key = String(params.name || '');
    const script = (config.commands || {})[key];
    if (!script) throw new Error(`unknown command: ${key}`);
    const out = await sh(script, [], 60000);
    if (out === null) throw new Error(`command failed: ${key}`);
    log(`command run: ${key}`);
    return { ok: true, action: 'command', name: key, output: out.trim().slice(0, 2000) };
  }
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) throw new Error(`unknown action: ${name}`);
  if (!config.allowActions[name]) throw new Error(`action disabled: ${name} (enable it in config.json)`);
  if ((name === 'lock' || name === 'notify') && !(await consoleUID())) {
    throw new Error('no user is logged in on this Mac');
  }
  const result = await ACTIONS[name](params || {});
  // sh() resolves to null when the command failed.
  if (result === null) throw new Error(`${name} failed`);
  log(`action run: ${name}`);
  return { ok: true, action: name, result: typeof result === 'string' ? result : 'ok' };
}

// HTTP server

function isPrivateIP(ip) {
  const a = ip.replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

function tokenOK(req) {
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = config.token || '';
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Hash both values first; timingSafeEqual requires equal lengths.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const url = new URL(req.url, 'http://localhost');

  const allowList = config.allowedIPs || [];
  const ipAllowed = allowList.length ? allowList.includes(remote) : isPrivateIP(remote);
  if (!ipAllowed) return send(res, 403, { error: 'address not allowed' });

  // Unauthenticated so Homey can check the address before the token is entered.
  if (url.pathname === '/ping') {
    return send(res, 200, {
      ok: true,
      service: 'homey-mac-agent',
      name: staticInfo ? staticInfo.computerName : os.hostname(),
      version: '1.0.0'
    });
  }

  if (!tokenOK(req)) return send(res, 401, { error: 'invalid or missing token' });

  if (url.pathname === '/status' && req.method === 'GET') {
    if (!snapshot.ready) await refreshSnapshot();
    if (url.searchParams.get('updates') === 'refresh') {
      await checkUpdates();
      // checkUpdates replaces updateCache, so point the snapshot at the new object.
      snapshot.updates = updateCache;
    }
    return send(res, 200, snapshot);
  }

  if (url.pathname === '/action' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const result = await runAction(String(body.action || ''), body.params || body);
        send(res, 200, result);
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  send(res, 404, { error: 'not found' });
});

// Startup

let bonjour = null;
let bonjourRetry = null;
let shuttingDown = false;
function advertiseBonjour() {
  if (!config.advertiseBonjour) return;
  const name = (staticInfo ? staticInfo.computerName : os.hostname()).replace(/[^\p{L}\p{N} ._-]/gu, '') || 'Mac';
  // Homey identifies the device by the TXT id; the serial number survives IP changes.
  const id = (staticInfo && staticInfo.serial) || os.hostname();
  bonjour = spawn(
    '/usr/bin/dns-sd',
    ['-R', name, '_homeymac._tcp', 'local', String(config.port),
     `id=${id}`, `name=${name}`, `ver=1.0.0`],
    { stdio: 'ignore' }
  );
  bonjour.on('error', (e) => log('could not start dns-sd: ' + e.message));
  bonjour.on('exit', (code) => {
    if (shuttingDown) return;
    log(`dns-sd exited (${code}), retrying in 30 s`);
    clearTimeout(bonjourRetry);
    bonjourRetry = setTimeout(advertiseBonjour, 30000);
  });
}

async function main() {
  if (!config.token) {
    log('ERROR: no token in config.json, exiting.');
    process.exit(1);
  }
  await readStaticInfo();
  await refreshSnapshot();
  cpuUsagePercent(); // first sample

  setInterval(() => refreshSnapshot().catch((e) => log('snapshot failed: ' + e.message)),
    Math.max(5, config.pollSeconds) * 1000);

  // Delay the first update check so startup stays fast.
  setTimeout(() => checkUpdates().catch(() => {}), 60000);
  setInterval(() => {
    readStaticInfo().catch(() => {});
    checkUpdates().catch(() => {});
  }, Math.max(1, config.updateCheckHours) * 3600 * 1000);

  server.listen(config.port, '0.0.0.0', () => {
    log(`homey-mac-agent listening on port ${config.port} (${staticInfo.computerName})`);
    advertiseBonjour();
  });
  server.on('error', (e) => {
    log('server error: ' + e.message);
    process.exit(1);
  });
}

process.on('SIGTERM', () => {
  shuttingDown = true;
  clearTimeout(bonjourRetry);
  if (bonjour) bonjour.kill();
  server.close(() => process.exit(0));
});

main().catch((e) => {
  log('startup failed: ' + e.stack);
  process.exit(1);
});
