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

    this.triggers = {
      updatesFound: trigger('updates_found'),
      rebooted: trigger('rebooted'),
      wentOffline: trigger('went_offline'),
      cameOnline: trigger('came_online'),
    };

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
