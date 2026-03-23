'use strict';

const os = require('os');
const { getEnv } = require('./config');

function isPrivateIPv4(address) {
  if (!address || typeof address !== 'string') return false;
  if (address.startsWith('10.')) return true;
  if (address.startsWith('192.168.')) return true;
  const match = address.match(/^172\.(\d+)\./);
  return !!(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function interfacePriority(name = '') {
  const normalized = String(name).toLowerCase();
  if (/wi-?fi|wireless|wlan/.test(normalized)) return 5;
  if (/ethernet|en|eth/.test(normalized)) return 4;
  if (/lan/.test(normalized)) return 3;
  if (/vmware|virtual|vbox|hyper-v|loopback/.test(normalized)) return -5;
  return 1;
}

function getLocalIPv4Address() {
  const configured = getEnv('UPLAYER_PUBLIC_HOST', '');
  if (configured) return configured;

  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      const family = typeof entry.family === 'string' ? entry.family : String(entry.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (!isPrivateIPv4(entry.address)) continue;
      candidates.push({
        name,
        address: entry.address,
        priority: interfacePriority(name),
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.length > 0 ? candidates[0].address : 'localhost';
}

function getBindHost() {
  return getEnv('UPLAYER_BIND_HOST', '0.0.0.0');
}

function normalizePath(pathname = '') {
  if (!pathname) return '';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function buildAccessibleUrls(port, options = {}) {
  const protocol = options.protocol || 'http';
  const path = normalizePath(options.path || '');
  const localhost = `${protocol}://localhost:${port}${path}`;
  const ipHost = options.publicHost || getLocalIPv4Address();
  const ip = `${protocol}://${ipHost}:${port}${path}`;
  return {
    localhost,
    ip,
    preferred: ip,
    custom: ip,
    hostname: ipHost,
    publicHost: ipHost,
    bindHost: options.bindHost || getBindHost(),
  };
}

module.exports = {
  getLocalIPv4Address,
  getBindHost,
  buildAccessibleUrls,
};
