'use strict';

const STORE_KEYS = {
  deviceId:  'divoom_device_id',
  deviceMac: 'divoom_device_mac',
  hardware:  'divoom_hardware',
};

function normalizeDeviceId(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeDeviceMac(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  return normalized || null;
}

function normalizeDiscoveredDevice(raw = {}) {
  const ip = String(raw.ip || raw.DevicePrivateIP || '').trim();
  const name = String(raw.name || raw.DeviceName || 'Pixoo64').trim() || 'Pixoo64';
  const deviceId = normalizeDeviceId(raw.deviceId ?? raw.DeviceId);
  const deviceMac = normalizeDeviceMac(raw.deviceMac ?? raw.DeviceMac);
  const hardwareValue = raw.hardware ?? raw.Hardware;
  const hardware = hardwareValue === undefined || hardwareValue === null
    ? null
    : hardwareValue;

  return {
    ip,
    name,
    deviceId,
    deviceMac,
    hardware,
  };
}

function hasIdentity(identity = {}) {
  return Boolean(
    normalizeDeviceMac(identity.deviceMac)
    || normalizeDeviceId(identity.deviceId),
  );
}

function findIdentityMatch(devices, identity = {}) {
  const normalizedDevices = (Array.isArray(devices) ? devices : [])
    .map(normalizeDiscoveredDevice);
  const deviceMac = normalizeDeviceMac(identity.deviceMac);
  const deviceId = normalizeDeviceId(identity.deviceId);

  if (deviceMac) {
    const matches = normalizedDevices.filter((device) => device.deviceMac === deviceMac);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }

  if (deviceId) {
    const matches = normalizedDevices.filter((device) => device.deviceId === deviceId);
    if (matches.length === 1) return matches[0];
  }

  return null;
}

function toStore(device = {}) {
  const normalized = normalizeDiscoveredDevice(device);
  const store = {};

  if (normalized.deviceId) store[STORE_KEYS.deviceId] = normalized.deviceId;
  if (normalized.deviceMac) store[STORE_KEYS.deviceMac] = normalized.deviceMac;
  if (normalized.hardware !== null) store[STORE_KEYS.hardware] = normalized.hardware;

  return store;
}

module.exports = {
  STORE_KEYS,
  normalizeDeviceId,
  normalizeDeviceMac,
  normalizeDiscoveredDevice,
  hasIdentity,
  findIdentityMatch,
  toStore,
};
