'use strict';

const dgram = require('dgram');

function parseMac(mac) {
  const hex = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || hex === '000000000000' || hex === '020000000000') return null;
  return Buffer.from(hex, 'hex');
}

function broadcastAddress(ip, netmask) {
  const a = String(ip || '').split('.').map(Number);
  const m = String(netmask || '').split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || [...a, ...m].some((n) => !Number.isInteger(n))) return null;
  return a.map((octet, i) => (octet & m[i]) | (~m[i] & 255)).join('.');
}

// Magic packet: 6 x 0xFF followed by the MAC address 16 times.
function magicPacket(macBuffer) {
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuffer)]);
}

function send(packet, address, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, address, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// Sends the packet to the subnet broadcast (when known) and the global broadcast, on ports 9 and 7.
async function wake(mac, { broadcast } = {}) {
  const macBuffer = parseMac(mac);
  if (!macBuffer) throw new Error('invalid_mac');
  const packet = magicPacket(macBuffer);
  const targets = [...new Set([broadcast, '255.255.255.255'].filter(Boolean))];
  const results = await Promise.allSettled(
    targets.flatMap((address) => [9, 7].map((port) => send(packet, address, port))),
  );
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
}

module.exports = { wake, parseMac, broadcastAddress, magicPacket };
