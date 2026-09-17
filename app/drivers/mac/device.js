'use strict';

const Homey = require('homey');
const { getStatus, checkUpdates, runAction } = require('../../lib/agent-api');
const wol = require('../../lib/wake-on-lan');

// A single missed poll is normal for a busy or sleeping Mac.
const FAILURES_BEFORE_OFFLINE = 3;

// Not every Mac reports these: the GPU sensor is only powered while the GPU is
// busy, and fanless models have no fan. They are added once a value arrives and
// removed if none has ever been seen on this Mac.
const OPTIONAL_CAPABILITIES = ['measure_temperature.gpu', 'mac_fan_rpm', 'measure_power'];

module.exports = class MacDevice extends Homey.Device {

  async onInit() {
    this.failures = 0;
    this.online = false;
    this.offline = false;
    this.previous = {};
    this.pollTimer = null;
    this.lastUpdated = null;
    this.sleepRequestedAt = 0;

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

    if (isNum(value)) {
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
    let status;
    try {
      status = await getStatus(this.connection());
    } catch (err) {
      return this.onPollFailed(err);
    }
    await this.handleStatus(status);
  }

  async handleStatus(status) {
    this.failures = 0;
    this.sleepRequestedAt = 0;
    this.lastUpdated = Date.now();
    if (this.offline) {
      this.offline = false;
      await this.unsetWarning().catch(() => {});
    }
    if (!this.online) {
      this.online = true;
      this.driver.triggers.cameOnline.trigger(this, {}, {}).catch(() => {});
    }

    try {
      await this.applyStatus(status);
    } catch (err) {
      this.error('Could not apply status', err);
    }
  }

  async onPollFailed(err) {
    this.failures += 1;
    if (this.failures < FAILURES_BEFORE_OFFLINE || this.offline) return;

    this.offline = true;
    this.online = false;
    const asleep = Date.now() - this.sleepRequestedAt < 15 * 60 * 1000;
    await this.setWarning(this.homey.__(asleep ? 'device.asleep' : 'device.unreachable')).catch(() => {});
    this.driver.triggers.wentOffline.trigger(this, {}, {}).catch(() => {});
    this.log(`Unreachable: ${err.message}`);
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

    await this.updateInfoSettings(s);
    await this.rememberAgentDetails(s);
    await this.runTriggers(s);

    this.previous = this.stateOf(s);
  }

  stateOf(s) {
    const cpu = s.cpu || {};
    return {
      cpuUsage: num(cpu.usagePercent),
      memory: num((s.memory || {}).percent),
      diskFree: num((s.disk || {}).freeGB),
      fanRpm: num((s.thermal || {}).fanRpm),
      updates: (s.updates || {}).count || 0,
      uptime: s.uptimeSeconds || 0,
    };
  }

  async rememberAgentDetails(s) {
    const commands = Array.isArray(s.commandsAvailable) ? s.commandsAvailable : [];
    if (JSON.stringify(commands) !== JSON.stringify(this.getStoreValue('commands') || [])) {
      await this.setStoreValue('commands', commands).catch(() => {});
    }

    // Wake-on-LAN needs the interface Homey talks to, which is not always the default route.
    const net = s.network || {};
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

  async runTriggers(s) {
    const p = this.previous;
    if (p.uptime === undefined) return; // first poll, nothing to compare with

    const cur = this.stateOf(s);
    const t = this.driver.triggers;

    for (const trig of this.driver.thresholdTriggers) {
      const before = p[trig.key];
      const now = cur[trig.key];
      if (!isNum(before) || !isNum(now) || before === now) continue;
      trig.card.trigger(this, { [trig.token]: now }, { prev: before, cur: now }).catch(() => {});
    }
    if (cur.updates > p.updates) {
      const names = ((s.updates || {}).items || []).map((i) => i.title).join(', ');
      t.updatesFound.trigger(this, { count: cur.updates, names: names || '-' }, {}).catch(() => {});
    }
    // Uptime going backwards means the Mac restarted.
    if (cur.uptime > 0 && p.uptime > 0 && cur.uptime < p.uptime) {
      t.rebooted.trigger(this, {}, {}).catch(() => {});
    }
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
