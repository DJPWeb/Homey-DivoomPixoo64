'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDeviceId,
  normalizeDeviceMac,
  normalizeDiscoveredDevice,
  hasIdentity,
  findIdentityMatch,
  toStore,
} = require('../lib/DeviceIdentity');

test('normalizes Divoom identity values', () => {
  assert.equal(normalizeDeviceId(300000020), '300000020');
  assert.equal(normalizeDeviceMac('A8:03:2A:FF:46:B1'), 'a8032aff46b1');
  assert.equal(normalizeDeviceMac('a8-03-2a-ff-46-b1'), 'a8032aff46b1');
});

test('normalizes cloud discovery records', () => {
  assert.deepEqual(
    normalizeDiscoveredDevice({
      DeviceName:      'Living Room',
      DeviceId:        300000020,
      DevicePrivateIP: '192.168.1.42',
      DeviceMac:       'A8032AFF46B1',
      Hardware:        400,
    }),
    {
      ip:        '192.168.1.42',
      name:      'Living Room',
      deviceId:  '300000020',
      deviceMac: 'a8032aff46b1',
      hardware:  400,
    },
  );
});

test('matches by MAC before falling back to device ID', () => {
  const devices = [
    {
      ip:        '192.168.1.41',
      deviceId:  '100',
      deviceMac: '001122334455',
    },
    {
      ip:        '192.168.1.42',
      deviceId:  '200',
      deviceMac: 'a8032aff46b1',
    },
  ];

  assert.equal(
    findIdentityMatch(devices, {
      deviceId:  '100',
      deviceMac: 'A8:03:2A:FF:46:B1',
    }).ip,
    '192.168.1.42',
  );
  assert.equal(findIdentityMatch(devices, { deviceId: 100 }).ip, '192.168.1.41');
});

test('rejects ambiguous identity matches', () => {
  const devices = [
    { ip: '192.168.1.41', deviceMac: '001122334455' },
    { ip: '192.168.1.42', deviceMac: '001122334455' },
  ];

  assert.equal(findIdentityMatch(devices, { deviceMac: '001122334455' }), null);
});

test('creates persistent Homey store data only for known identity fields', () => {
  const device = {
    deviceId:  300000020,
    deviceMac: 'A8:03:2A:FF:46:B1',
    hardware:  400,
  };

  assert.equal(hasIdentity(device), true);
  assert.deepEqual(toStore(device), {
    divoom_device_id:  '300000020',
    divoom_device_mac: 'a8032aff46b1',
    divoom_hardware:   400,
  });
  assert.deepEqual(toStore({}), {});
});
