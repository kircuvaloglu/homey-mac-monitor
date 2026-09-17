'use strict';

const http = require('http');

const STATUS_MESSAGES = {
  401: 'Token rejected',
  403: 'Request refused by the agent',
  404: 'Unknown endpoint',
};

function request({ host, port = 8787, token = null, path = '/status', method = 'GET', body = null, timeout = 8000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }

    const req = http.request({ host, port, path, method, headers, timeout }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 2 * 1024 * 1024) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          return reject(Object.assign(new Error('Invalid response'), { statusCode: res.statusCode }));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // 400 carries the agent's own explanation, e.g. a disabled action.
          const detail = res.statusCode === 400 && parsed && parsed.error;
          const err = new Error(detail || STATUS_MESSAGES[res.statusCode] || `HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });

    // A sleeping Mac can leave the socket hanging, so enforce the timeout ourselves.
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const getStatus = (opts) => request({ ...opts, path: '/status' });
// softwareupdate can take a minute or more.
const checkUpdates = (opts) => request({ ...opts, path: '/status?updates=refresh', timeout: 180000 });
const ping = (opts) => request({ ...opts, path: '/ping', token: null, timeout: opts.timeout || 4000 });
const runAction = (opts, action, params = {}) =>
  request({ ...opts, path: '/action', method: 'POST', body: { action, params }, timeout: 70000 });

module.exports = { request, getStatus, checkUpdates, ping, runAction };
