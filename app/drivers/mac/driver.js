'use strict';

const Homey = require('homey');
const { getStatus, ping } = require('../../lib/agent-api');

// The web app sends an object; events sent through the API can arrive as a JSON string.
function parsePayload(payload) {
  if (typeof payload === 'string') {
    try { return JSON.parse(payload) || {}; } catch { return {}; }
  }
  return payload || {};
}

// id: trigger card, key: value in the device state, arg: card argument,
// rising: fire when crossing upwards, token: token name on the card.
const THRESHOLD_TRIGGERS = [
  { id: 'cpu_usage_above', key: 'cpuUsage', arg: 'percent', rising: true, token: 'percent' },
  { id: 'cpu_usage_below', key: 'cpuUsage', arg: 'percent', rising: false, token: 'percent' },
  { id: 'memory_above', key: 'memory', arg: 'percent', rising: true, token: 'percent' },
  { id: 'memory_below', key: 'memory', arg: 'percent', rising: false, token: 'percent' },
  { id: 'disk_free_below', key: 'diskFree', arg: 'gigabytes', rising: false, token: 'free' },
  { id: 'disk_free_above', key: 'diskFree', arg: 'gigabytes', rising: true, token: 'free' },
  { id: 'fan_above', key: 'fanRpm', arg: 'rpm', rising: true, token: 'rpm' },
  { id: 'idle_above', key: 'idleMinutes', arg: 'minutes', rising: true, token: 'minutes' },
  { id: 'network_down_above', key: 'downMbps', arg: 'mbps', rising: true, token: 'mbps' },
  { id: 'network_up_above', key: 'upMbps', arg: 'mbps', rising: true, token: 'mbps' },
  { id: 'backup_overdue', key: 'backupAgeHours', arg: 'hours', rising: true, token: 'hours' },
];

// Triggers without arguments, fired by the device when a state changes.
const EVENT_TRIGGERS = [
  'updates_found', 'rebooted', 'went_offline', 'came_online',
  'user_active', 'screen_locked', 'screen_unlocked', 'display_on', 'display_off',
  'memory_pressure_changed', 'thermal_state_changed',
  'disk_failing', 'backup_finished', 'drive_connected', 'drive_disconnected',
];

module.exports = class MacDriver extends Homey.Driver {

  async onInit() {
    const trigger = (id) => this.homey.flow.getDeviceTriggerCard(id);

    // Threshold triggers fire only when the value crosses the threshold.
    this.thresholdTriggers = THRESHOLD_TRIGGERS.map((t) => {
      const card = trigger(t.id);
      card.registerRunListener((args, state) => (t.rising
        ? state.prev < args[t.arg] && state.cur >= args[t.arg]
        : state.prev > args[t.arg] && state.cur <= args[t.arg]));
      return { ...t, card };
    });

    this.events = Object.fromEntries(EVENT_TRIGGERS.map((id) => [id, trigger(id)]));

    const condition = (id, fn) => this.homey.flow.getConditionCard(id).registerRunListener(fn);
    const above = (capability, arg) => async (args) => {
      const v = args.device.getCapabilityValue(capability);
      return typeof v === 'number' && v > args[arg];
    };
    condition('is_online', async (args) => args.device.isOnline());
    condition('cpu_temp_greater', above('measure_temperature.cpu', 'celsius'));
    condition('cpu_usage_greater', above('mac_cpu_usage', 'percent'));
    condition('memory_greater', above('mac_memory_usage', 'percent'));
    condition('disk_free_greater', above('mac_disk_free', 'gigabytes'));
    condition('fan_greater', above('mac_fan_rpm', 'rpm'));
    condition('power_greater', above('measure_power', 'watts'));
    condition('has_updates', async (args) => !!args.device.getCapabilityValue('mac_update_available'));
    const is = (capability) => async (args) => args.device.getCapabilityValue(capability) === true;
    condition('screen_is_locked', is('mac_screen_locked'));
    condition('display_is_on', is('mac_display_on'));
    condition('idle_longer', async (args) => {
      const v = args.device.getCapabilityValue('mac_idle');
      return typeof v === 'number' && v >= args.minutes;
    });
    condition('memory_pressure_is', async (args) =>
      String(args.device.getCapabilityValue('mac_memory_pressure') || '').toLowerCase() === args.level);
    condition('backup_older', async (args) => {
      const age = args.device.backupAgeHours();
      return age !== null && age > args.hours;
    });

    const appRunning = this.homey.flow.getConditionCard('app_running');
    appRunning.registerRunListener(async (args) => args.device.isAppRunning(args.app.name));
    appRunning.registerArgumentAutocompleteListener('app', async (query, args) => args.device.findApps(query));

    const driveConnected = this.homey.flow.getConditionCard('drive_connected');
    driveConnected.registerRunListener(async (args) =>
      (args.device.getStoreValue('drives') || []).includes(args.drive.name));
    driveConnected.registerArgumentAutocompleteListener('drive', async (query, args) => {
      const q = String(query || '').toLowerCase();
      const names = new Set([...(args.device.getStoreValue('drives') || []), ...(args.device.getStoreValue('knownDrives') || [])]);
      return [...names].filter((n) => n.toLowerCase().includes(q)).map((n) => ({ id: n, name: n }));
    });

    const action = (id, fn) => this.homey.flow.getActionCard(id).registerRunListener(fn);
    action('sleep', ({ device }) => device.sleep());
    action('wake', ({ device }) => device.wake());
    action('display_sleep', ({ device }) => device.agentAction('displaysleep'));
    action('lock', ({ device }) => device.agentAction('lock'));
    action('notify', ({ device, title, message }) => device.agentAction('notify', { title, message }));
    action('refresh', ({ device }) => device.poll());
    action('check_updates', ({ device }) => device.checkUpdates());
    action('restart', ({ device }) => device.powerAction('restart'));
    action('shutdown', ({ device }) => device.powerAction('shutdown'));
    action('keep_awake', ({ device, minutes }) => device.agentAction('keepawake', { minutes }));
    action('allow_sleep', ({ device }) => device.agentAction('allowsleep'));
    action('say', ({ device, text }) => device.agentAction('say', { text }));

    const runCommand = this.homey.flow.getActionCard('run_command');
    runCommand.registerRunListener(async ({ device, command }) => ({ output: await device.runCommand(command.id) }));
    runCommand.registerArgumentAutocompleteListener('command', async (query, { device }) => {
      const q = String(query || '').toLowerCase();
      return (device.getStoreValue('commands') || [])
        .filter((name) => name.toLowerCase().includes(q))
        .map((name) => ({ id: name, name }));
    });

    this.log('Mac driver initialized');
  }

  getDiscovered() {
    const results = this.getDiscoveryStrategy().getDiscoveryResults();
    return Object.values(results).map((r) => ({
      id: r.id,
      host: r.address,
      port: r.port,
      name: (r.txt && r.txt.name) || r.name || r.host || r.address,
    }));
  }

  connectionOptions(payload) {
    const { host, port, token } = parsePayload(payload);
    const opts = { host: String(host || '').trim(), port: Number(port) || 8787, token: String(token || '').trim() };
    if (!opts.host) throw new Error(this.homey.__('pair.error.noHost'));
    if (!opts.token) throw new Error(this.homey.__('pair.error.noToken'));
    return opts;
  }

  async fetchStatus(opts) {
    try {
      return await getStatus(opts);
    } catch (err) {
      if (err.statusCode === 401) throw new Error(this.homey.__('pair.error.badToken'));
      throw new Error(this.homey.__('pair.error.unreachable', { message: err.message }));
    }
  }

  async onPair(session) {
    let pending = null;

    session.setHandler('discovered', async () => {
      try {
        return this.getDiscovered();
      } catch (err) {
        this.error('Discovery failed', err);
        return [];
      }
    });

    session.setHandler('connect', async (payload) => {
      const opts = this.connectionOptions(payload);

      // Ping first so a wrong address and a wrong token give different errors.
      try {
        await ping(opts);
      } catch (err) {
        throw new Error(this.homey.__('pair.error.unreachable', { message: err.message }));
      }

      const sys = (await this.fetchStatus(opts)).system || {};
      pending = {
        name: sys.computerName || sys.hostname || opts.host,
        data: { id: sys.serial || `${opts.host}:${opts.port}` },
        store: { token: opts.token },
        settings: { host: opts.host, port: opts.port, pollInterval: 30 },
      };
      return { name: pending.name, model: sys.model || null, os: sys.os || null };
    });

    session.setHandler('list_devices', async () => (pending ? [pending] : []));
  }

  // Repair updates the address and token of an existing device.
  async onRepair(session, device) {
    session.setHandler('discovered', async () => {
      try {
        return this.getDiscovered();
      } catch {
        return [];
      }
    });

    session.setHandler('connect', async (payload) => {
      const opts = this.connectionOptions(payload);
      const sys = (await this.fetchStatus(opts)).system || {};

      await device.setStoreValue('token', opts.token);
      await device.setSettings({ host: opts.host, port: opts.port });
      device.restartPolling();

      return { name: sys.computerName || opts.host, model: sys.model || null, os: sys.os || null, repaired: true };
    });
  }

};
