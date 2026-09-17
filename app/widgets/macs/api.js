'use strict';

function macFromDevice(device) {
  const read = (id) => (device.hasCapability(id) ? device.getCapabilityValue(id) : null);
  return {
    id: device.getData().id,
    name: device.getName(),
    available: device.getAvailable() && !(device.isOffline && device.isOffline()),
    lastUpdated: device.lastUpdated || null,
    temperature: read('measure_temperature.cpu'),
    usage: read('mac_cpu_usage'),
    memory: read('mac_memory_usage'),
    diskFree: read('mac_disk_free'),
    diskUsage: read('mac_disk_usage'),
    fanRpm: read('mac_fan_rpm'),
    power: read('measure_power'),
    uptime: read('mac_uptime'),
    updates: read('mac_updates'),
    throttled: read('alarm_heat'),
    down: read('mac_network_down'),
    up: read('mac_network_up'),
    locked: read('mac_screen_locked'),
    idle: read('mac_idle'),
  };
}

function getDevices(homey) {
  return homey.drivers.getDriver('mac').getDevices();
}

module.exports = {

  // Reads the current capability values; the devices already poll the agents.
  async getMacs({ homey }) {
    let devices;
    try {
      devices = getDevices(homey);
    } catch (err) {
      return { macs: [], error: 'driver_not_ready' };
    }
    const macs = devices.map(macFromDevice);
    macs.sort((a, b) => a.name.localeCompare(b.name));
    return { macs };
  },

  // Polls one Mac right away and returns its new values.
  async refreshMac({ homey, body }) {
    const id = body && body.id;
    const device = getDevices(homey).find((d) => d.getData().id === id);
    if (!device) throw new Error('Mac not found');
    await device.poll();
    return macFromDevice(device);
  },

};
