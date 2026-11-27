'use strict';

const Homey = require('homey');
const { getStatus, checkUpdates, runAction, getProcesses, ping } = require('../../lib/agent-api');
const wol = require('../../lib/wake-on-lan');

// A single missed poll is normal for a busy or sleeping Mac.
const FAILURES_BEFORE_OFFLINE = 3;

// The agent version this app is made for. Older agents keep working, but miss the
// readings added since; the user is told once per Mac and agent version.
const AGENT_LATEST = '1.7.0';

// How often the apps chosen in "starts" and "stops" Flows are read again, in case
// a change was not announced.
const WATCH_LIST_MAX_AGE = 5 * 60 * 1000;

// Not every Mac reports these: the GPU sensor is only powered while the GPU is
// busy, fanless models have no fan, and the session values need a logged-in user. They are added once a value arrives and
// removed if none has ever been seen on this Mac.
const OPTIONAL_CAPABILITIES = [
  'measure_temperature.gpu', 'mac_fan_rpm', 'measure_power',
  'mac_screen_locked', 'mac_display_on', 'mac_idle',
  'mac_network_down', 'mac_network_up', 'mac_memory_pressure', 'mac_thermal_state',
  'mac_disk_health', 'mac_last_backup',
  'mac_gpu_usage', 'mac_internet', 'mac_internet_latency',
];

const has = (v) => v !== null && v !== undefined;
const isBool = (v) => typeof v === 'boolean';

// Compares dotted version numbers: negative when a is older than b.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Addresses that may belong to this Mac on the home network: the network ports
// (en0, en1, ...) with a private IPv4 address. Bridges for virtual machines and
// VPN tunnels are left out, Homey cannot reach them.
function homeAddresses(interfaces) {
  const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return (interfaces || [])
    .filter((i) => /^en\d+$/.test(i.interface || '') && isPrivate(i.ip || ''))
    .map((i) => i.ip);
}
const capitalize = (v) => (typeof v === 'string' && v ? v[0].toUpperCase() + v.slice(1) : v);

module.exports = class MacDevice extends Homey.Device {

  async onInit() {
    this.failures = 0;
    this.online = false;
    this.offline = false;
    this.previous = {};
    this.pollTimer = null;
    this.lastUpdated = null;
    this.sleepRequestedAt = 0;
    this.watchList = [];
    this.watchListAt = 0;

    await this.migrateCapabilities();
    // An unreachable Mac is shown with a warning instead of as unavailable, because Homey
    // refuses to run Flow actions (such as Wake-on-LAN) on unavailable devices.
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});

    this.log(`${this.getName()} initialized (${this.getSetting('host')})`);
    this.restartPolling();
  }

  // Adds capabilities introduced by app updates to existing devices.
  async migrateCapabilities() {
    const wanted = this.driver.manifest.capabilities || [];
    for (const cap of wanted) {
      if (OPTIONAL_CAPABILITIES.includes(cap)) continue;
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((err) => this.error(`Could not add ${cap}`, err));
      }
    }
  }

  // Keeps the last known value when a sensor that was seen before goes quiet.
  async setOptional(capability, value) {
    const seen = this.getStoreValue('supported') || {};

    if (has(value) && (typeof value !== 'number' || isNum(value))) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch((err) => this.error(`Could not add ${capability}`, err));
      }
      if (!seen[capability]) {
        seen[capability] = true;
        await this.setStoreValue('supported', seen).catch(() => {});
      }
      await this.set(capability, value);
      return;
    }

    if (!seen[capability] && this.hasCapability(capability)) {
      await this.removeCapability(capability).catch((err) => this.error(`Could not remove ${capability}`, err));
    }
  }

  // Homey matches a device to its agent by the serial number in the Bonjour record.
  onDiscoveryResult(result) {
    return result.id === this.getData().id;
  }

  async onDiscoveryAvailable(result) {
    await this.followAddress(result);
  }

  async onDiscoveryAddressChanged(result) {
    await this.followAddress(result);
  }

  // Follows the Mac when it gets another address, but only while the known address
  // has stopped answering: a Mac on two networks is also announced on the address
  // Homey cannot reach, and that address must not replace a working one.
  async followAddress(result) {
    const host = result && result.address;
    if (!host || !this.offline || host === this.getSetting('host')) return;
    const port = result.port || this.getSetting('port') || 8787;

    try {
      await ping({ host, port, timeout: 4000 });
    } catch (err) {
      return;
    }

    this.log(`Now at ${host}:${port}`);
    await this.setSettings({ host, port }).catch((err) => this.error('Could not store the address', err));
    this.restartPolling();
  }

  connection() {
    return {
      host: this.getSetting('host'),
      port: this.getSetting('port') || 8787,
      token: this.getStoreValue('token'),
      timeout: 8000,
    };
  }

  isOnline() {
    return this.online;
  }

  isOffline() {
    return this.offline;
  }

  restartPolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    const seconds = Math.max(10, this.getSetting('pollInterval') || 30);
    this.pollTimer = this.homey.setInterval(() => this.poll().catch(() => {}), seconds * 1000);
    this.poll().catch(() => {});
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.some((k) => ['host', 'port', 'pollInterval'].includes(k))) {
      // New settings are only applied after this handler returns.
      this.homey.setTimeout(() => this.restartPolling(), 500);
    }
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
  }

  async poll() {
    if (Date.now() - this.watchListAt > WATCH_LIST_MAX_AGE) await this.refreshWatchList().catch(() => {});
    let status;
    try {
      status = await getStatus(this.connection(), { watch: this.watchList });
    } catch (err) {
      return this.onPollFailed(err);
    }
    await this.handleStatus(status);
  }

  // The apps chosen in this Mac's "starts" and "stops" Flows; only these are asked about.
  async refreshWatchList() {
    this.watchListAt = Date.now();
    const names = new Set();
    for (const card of Object.values(this.driver.appTriggers)) {
      const flows = await card.getArgumentValues(this).catch(() => []);
      for (const args of flows) {
        const name = args && args.app && args.app.name;
        // The agent takes a comma-separated list.
        if (name && !String(name).includes(',')) names.add(String(name));
      }
    }
    this.watchList = [...names].slice(0, 30);
  }

  // A device belongs to one Mac, identified by its serial number. After a swap or a
  // changed address another Mac can end up answering here, and its readings must not
  // pass as this one's without a word.
  async checkIdentity(status) {
    const serial = (status.system || {}).serial;
    const id = this.getData().id;
    // Devices added before the serial was used as the id carry "host:port" instead.
    if (!serial || !id || id.includes(':') || serial === id) {
      this.wrongMac = false;
      return;
    }
    if (this.wrongMac) return;
    this.wrongMac = true;
    this.log(`Another Mac answers at ${this.getSetting('host')}: ${serial} instead of ${id}`);
    await this.setWarning(this.homey.__('device.otherMac')).catch(() => {});
  }

  async handleStatus(status) {
    this.failures = 0;
    this.sleepRequestedAt = 0;
    this.lastUpdated = Date.now();
    if (this.offline) {
      this.offline = false;
      if (!this.wrongMac) await this.unsetWarning().catch(() => {});
    }
    await this.checkIdentity(status);
    if (!this.online) {
      this.online = true;
      this.fire('came_online');
    }

    try {
      await this.applyStatus(status);
    } catch (err) {
      this.error('Could not apply status', err);
    }
  }

  async onPollFailed(err) {
    this.failures += 1;
    if (await this.tryOtherAddresses()) return;
    if (this.failures < FAILURES_BEFORE_OFFLINE || this.offline) return;

    this.offline = true;
    this.online = false;
    const asleep = Date.now() - this.sleepRequestedAt < 15 * 60 * 1000;
    await this.setWarning(this.homey.__(asleep ? 'device.asleep' : 'device.unreachable')).catch(() => {});
    this.fire('went_offline');
    this.log(`Unreachable: ${err.message}`);
  }

  // A Mac with both Ethernet and Wi-Fi has more than one address, and the one in use
  // can stop answering while another still works. The addresses seen in earlier
  // readings are asked at the same time, and the first one where this same Mac
  // answers (checked by its serial number) is kept.
  async tryOtherAddresses() {
    const host = this.getSetting('host');
    const id = this.getData().id;
    const candidates = (this.getStoreValue('addresses') || []).filter((a) => a !== host);
    if (!candidates.length || !id || id.includes(':')) return false;

    const { port, token } = this.connection();
    let found;
    try {
      found = await Promise.any(candidates.map(async (address) => {
        const status = await getStatus({ host: address, port, token, timeout: 3000 }, { watch: this.watchList });
        if ((status.system || {}).serial !== id) throw new Error('another Mac');
        return { address, status };
      }));
    } catch (err) {
      return false;
    }

    this.log(`Now at ${found.address}, ${host} stopped answering`);
    await this.setSettings({ host: found.address }).catch((err) => this.error('Could not store the address', err));
    await this.handleStatus(found.status);
    return true;
  }

  // Skips unchanged values so Insights is not flooded with duplicates.
  async set(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((e) => this.error(`Could not set ${capability}`, e));
  }

  async applyStatus(s) {
    const cpu = s.cpu || {};
    const thermal = s.thermal || {};
    const disk = s.disk || {};
    const memory = s.memory || {};
    const updates = s.updates || {};

    await this.set('measure_temperature.cpu', num(cpu.temperature));
    await this.setOptional('measure_temperature.gpu', num((s.gpu || {}).temperature));
    await this.set('mac_cpu_usage', num(cpu.usagePercent));
    await this.set('mac_cpu_load', num(cpu.load1PerCore));
    await this.set('mac_memory_usage', num(memory.percent));
    await this.set('mac_disk_free', num(disk.freeGB));
    await this.set('mac_disk_usage', num(disk.percent));
    await this.setOptional('mac_fan_rpm', num(thermal.fanRpm));
    await this.setOptional('measure_power', num(thermal.powerWatts));
    await this.set('alarm_heat', !!thermal.throttled);
    await this.set('mac_uptime', this.formatUptime(s.uptimeSeconds));
    await this.set('mac_updates', num(updates.count) || 0);
    await this.set('mac_update_available', (updates.count || 0) > 0);

    const activity = s.activity || {};
    const net = s.network || {};
    const state = this.stateOf(s);
    await this.setOptional('mac_screen_locked', activity.screenLocked);
    await this.setOptional('mac_display_on', activity.displayOn);
    await this.setOptional('mac_idle', state.idleMinutes);
    await this.setOptional('mac_network_down', num(net.downMbps));
    await this.setOptional('mac_network_up', num(net.upMbps));
    await this.setOptional('mac_memory_pressure', capitalize(memory.pressure));
    await this.setOptional('mac_thermal_state', capitalize(thermal.state));
    await this.setOptional('mac_disk_health', s.diskHealth);
    await this.setOptional('mac_last_backup', s.backup ? this.formatBackup(s.backup.lastBackup) : null);
    await this.set('mac_drives', Array.isArray(s.drives) ? s.drives.length : 0);

    const internet = s.internet || {};
    await this.setOptional('mac_gpu_usage', num((s.gpu || {}).usagePercent));
    await this.setOptional('mac_internet', isBool(internet.online) ? internet.online : null);
    // Without internet there is no latency; the last value must not linger in Insights.
    if (internet.online === false) await this.set('mac_internet_latency', null);
    else await this.setOptional('mac_internet_latency', num(internet.latencyMs));

    await this.updateInfoSettings(s);
    await this.rememberAgentDetails(s);
    await this.checkAgentVersion(s.agentVersion);
    await this.runTriggers(s);

    // A reading without the watched apps (an update check, for example) keeps the
    // last known state, so a start or stop is not missed.
    const next = this.stateOf(s);
    this.previous = { ...next, watched: next.watched || this.previous.watched || null };
  }

  async checkAgentVersion(version) {
    if (!version || compareVersions(version, AGENT_LATEST) >= 0) return;
    if (this.getStoreValue('agentNotified') === version) return;
    await this.setStoreValue('agentNotified', version).catch(() => {});
    await this.homey.notifications.createNotification({
      excerpt: this.homey.__('device.agentOutdated', { name: this.getName(), version, latest: AGENT_LATEST }),
    }).catch((err) => this.error('Could not send the notification', err));
  }

  stateOf(s) {
    const cpu = s.cpu || {};
    const activity = s.activity || {};
    const net = s.network || {};
    const backup = s.backup || null;
    return {
      cpuUsage: num(cpu.usagePercent),
      memory: num((s.memory || {}).percent),
      diskFree: num((s.disk || {}).freeGB),
      fanRpm: num((s.thermal || {}).fanRpm),
      idleMinutes: isNum(activity.idleSeconds) ? Math.floor(activity.idleSeconds / 60) : null,
      idleSeconds: num(activity.idleSeconds),
      screenLocked: has(activity.screenLocked) ? activity.screenLocked : null,
      displayOn: has(activity.displayOn) ? activity.displayOn : null,
      downMbps: num(net.downMbps),
      upMbps: num(net.upMbps),
      pressure: (s.memory || {}).pressure || null,
      thermalState: (s.thermal || {}).state || null,
      diskHealth: s.diskHealth || null,
      lastBackup: backup && backup.lastBackup ? Date.parse(backup.lastBackup) : null,
      backupAgeHours: backup && backup.lastBackup
        ? Math.floor((Date.now() - Date.parse(backup.lastBackup)) / 3600000) : null,
      drives: Array.isArray(s.drives) ? s.drives : null,
      gpuUsage: num((s.gpu || {}).usagePercent),
      internetOnline: isBool((s.internet || {}).online) ? s.internet.online : null,
      latencyMs: num((s.internet || {}).latencyMs),
      watched: s.watched && typeof s.watched === 'object' ? s.watched : null,
      topProcess: ((s.topProcesses || [])[0] || {}).name || '-',
      updates: (s.updates || {}).count || 0,
      uptime: s.uptimeSeconds || 0,
    };
  }

  async rememberAgentDetails(s) {
    if (Array.isArray(s.drives)) {
      if (JSON.stringify(s.drives) !== JSON.stringify(this.getStoreValue('drives') || [])) {
        await this.setStoreValue('drives', s.drives).catch(() => {});
      }
      // Remember drives seen before, so they can be picked in Flows while disconnected.
      const known = this.getStoreValue('knownDrives') || [];
      const merged = [...new Set([...known, ...s.drives])].slice(-50);
      if (merged.length !== known.length) await this.setStoreValue('knownDrives', merged).catch(() => {});
    }

    const commands = Array.isArray(s.commandsAvailable) ? s.commandsAvailable : [];
    if (JSON.stringify(commands) !== JSON.stringify(this.getStoreValue('commands') || [])) {
      await this.setStoreValue('commands', commands).catch(() => {});
    }

    const net = s.network || {};
    const addresses = homeAddresses(net.interfaces);
    if (JSON.stringify(addresses) !== JSON.stringify(this.getStoreValue('addresses') || [])) {
      await this.setStoreValue('addresses', addresses).catch(() => {});
    }

    // Wake-on-LAN needs the interface Homey talks to, which is not always the default route.
    const host = this.getSetting('host');
    const iface = (net.interfaces || []).find((i) => i.ip === host) || net.primary;
    if (iface && wol.parseMac(iface.mac)) {
      const target = { mac: iface.mac, broadcast: wol.broadcastAddress(iface.ip, iface.netmask) };
      const saved = this.getStoreValue('wol') || {};
      if (saved.mac !== target.mac || saved.broadcast !== target.broadcast) {
        await this.setStoreValue('wol', target).catch(() => {});
      }
    }
  }

  fire(id, tokens = {}) {
    this.driver.events[id].trigger(this, tokens, {}).catch(() => {});
  }

  async runTriggers(s) {
    const p = this.previous;
    if (p.uptime === undefined) return; // first poll, nothing to compare with

    const cur = this.stateOf(s);

    for (const trig of this.driver.thresholdTriggers) {
      const before = p[trig.key];
      const now = cur[trig.key];
      if (!isNum(before) || !isNum(now) || before === now) continue;
      const tokens = { [trig.token]: now };
      if (trig.id === 'cpu_usage_above') tokens.process = cur.topProcess;
      trig.card.trigger(this, tokens, { prev: before, cur: now }).catch(() => {});
    }

    const edge = (key, onId, offId) => {
      if (!has(p[key]) || !has(cur[key]) || p[key] === cur[key]) return;
      this.fire(cur[key] ? onId : offId);
    };
    edge('screenLocked', 'screen_locked', 'screen_unlocked');
    edge('displayOn', 'display_on', 'display_off');

    if (isNum(p.idleSeconds) && isNum(cur.idleSeconds) && p.idleSeconds >= 120 && cur.idleSeconds < 60) {
      this.fire('user_active');
    }
    if (p.pressure && cur.pressure && p.pressure !== cur.pressure) {
      this.fire('memory_pressure_changed', { pressure: cur.pressure });
    }
    if (p.thermalState && cur.thermalState && p.thermalState !== cur.thermalState) {
      this.fire('thermal_state_changed', { state: cur.thermalState });
    }
    if (cur.diskHealth && cur.diskHealth !== 'Verified' && cur.diskHealth !== p.diskHealth) {
      this.fire('disk_failing', { status: cur.diskHealth });
    }
    if (p.lastBackup && cur.lastBackup && cur.lastBackup > p.lastBackup) {
      this.fire('backup_finished', { time: this.formatTime(cur.lastBackup) });
    }
    if (p.drives && cur.drives) {
      cur.drives.filter((d) => !p.drives.includes(d)).forEach((name) => this.fire('drive_connected', { name }));
      p.drives.filter((d) => !cur.drives.includes(d)).forEach((name) => this.fire('drive_disconnected', { name }));
    }
    if (cur.updates > p.updates) {
      const names = ((s.updates || {}).items || []).map((i) => i.title).join(', ');
      this.fire('updates_found', { count: cur.updates, names: names || '-' });
    }
    if (isBool(p.internetOnline) && isBool(cur.internetOnline) && p.internetOnline !== cur.internetOnline) {
      this.fire(cur.internetOnline ? 'internet_up' : 'internet_down');
    }
    if (p.watched && cur.watched) {
      for (const [name, running] of Object.entries(cur.watched)) {
        if (!isBool(p.watched[name]) || p.watched[name] === running) continue;
        const card = this.driver.appTriggers[running ? 'started' : 'stopped'];
        card.trigger(this, { name }, { name }).catch(() => {});
      }
    }
    // Uptime going backwards means the Mac restarted.
    if (cur.uptime > 0 && p.uptime > 0 && cur.uptime < p.uptime) {
      this.fire('rebooted');
    }
  }

  backupAgeHours() {
    return isNum(this.previous.backupAgeHours) ? this.previous.backupAgeHours : null;
  }

  async processes() {
    try {
      return await getProcesses(this.connection());
    } catch (err) {
      throw new Error(this.homey.__('action.failed', { message: err.message }));
    }
  }

  async isAppRunning(name) {
    const { apps = [], processes = [] } = await this.processes();
    const target = String(name || '').toLowerCase();
    return [...apps, ...processes].some((n) => n.toLowerCase() === target);
  }

  // Apps from the Applications folders first, then other processes.
  async findApps(query) {
    const { apps = [], processes = [] } = await this.processes();
    const q = String(query || '').toLowerCase();
    const names = [...new Set([...apps, ...processes])].filter((n) => n.toLowerCase().includes(q));
    return names.slice(0, 50).map((n) => ({
      id: n,
      name: n,
      description: apps.includes(n) ? this.homey.__('app.application') : this.homey.__('app.process'),
    }));
  }

  // Actions

  async agentAction(name, params = {}) {
    try {
      return await runAction(this.connection(), name, params);
    } catch (err) {
      throw new Error(this.homey.__('action.failed', { message: err.message }));
    }
  }

  async sleep() {
    await this.agentAction('sleep');
    this.sleepRequestedAt = Date.now();
  }

  async powerAction(name) {
    if (!this.getSetting('allow_power_actions')) throw new Error(this.homey.__('action.powerNotAllowed'));
    await this.agentAction(name);
  }

  async runCommand(name) {
    if (!name) throw new Error(this.homey.__('action.noCommands'));
    const result = await this.agentAction('command', { name });
    return (result && result.output) || '';
  }

  async checkUpdates() {
    let status;
    try {
      status = await checkUpdates(this.connection());
    } catch (err) {
      throw new Error(this.homey.__('action.failed', { message: err.message }));
    }
    await this.handleStatus(status);
  }

  async wake() {
    const custom = String(this.getSetting('wol_mac') || '').trim();
    const saved = this.getStoreValue('wol') || {};
    if (custom && !wol.parseMac(custom)) throw new Error(this.homey.__('action.invalidMacAddress'));
    const mac = custom || saved.mac;
    if (!mac) throw new Error(this.homey.__('action.noMacAddress'));
    await wol.wake(mac, { broadcast: saved.broadcast });
    // Poll a few times so the device shows up again soon after waking.
    for (const delay of [10, 25, 45]) {
      this.homey.setTimeout(() => this.poll().catch(() => {}), delay * 1000);
    }
  }

  formatTime(ms) {
    try {
      return new Date(ms).toLocaleTimeString('en-GB', { timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit' });
    } catch {
      return new Date(ms).toISOString();
    }
  }

  formatBackup(iso) {
    if (!iso) return this.homey.__('backup.never');
    const hours = (Date.now() - Date.parse(iso)) / 3600000;
    if (hours < 1) return this.homey.__('backup.minutes', { n: Math.max(1, Math.round(hours * 60)) });
    if (hours < 48) return this.homey.__('backup.hours', { n: Math.round(hours) });
    return this.homey.__('backup.days', { n: Math.round(hours / 24) });
  }

  formatDate(iso) {
    try {
      return new Date(iso).toLocaleString('en-GB', { timeZone: this.homey.clock.getTimezone() });
    } catch {
      return new Date(iso).toISOString();
    }
  }

  async updateInfoSettings(s) {
    const sys = s.system || {};
    const net = (s.network || {}).primary || {};
    const updates = s.updates || {};
    const next = {
      info_model: sys.model || '-',
      info_serial: sys.serial || '-',
      info_os: sys.os ? `${sys.os} (${sys.build || '-'})` : '-',
      info_cpu: sys.cpu ? `${sys.cpu}, ${sys.cores || '?'} cores` : '-',
      info_memory: sys.memoryGB ? `${sys.memoryGB} GB` : '-',
      info_ip: net.ip ? `${net.ip} (${net.interface || '?'})` : '-',
      info_mac: net.mac || '-',
      info_bootedAt: s.bootedAt ? this.formatDate(s.bootedAt) : '-',
      info_updates: updates.checkedAt ? `${updates.count} (checked ${this.formatDate(updates.checkedAt)})` : '-',
      info_agent: s.agentVersion || '-',
    };

    const changed = {};
    for (const [k, v] of Object.entries(next)) {
      if (this.getSetting(k) !== v) changed[k] = v;
    }
    if (Object.keys(changed).length) {
      await this.setSettings(changed).catch((err) => this.error('Could not update info settings', err));
    }
  }

  formatUptime(seconds) {
    if (!seconds || seconds < 0) return '-';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const u = (key) => this.homey.__(`uptime.${key}`);
    if (d > 0) return `${d}${u('d')} ${h}${u('h')}`;
    if (h > 0) return `${h}${u('h')} ${m}${u('m')}`;
    return `${m}${u('m')}`;
  }

};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);
