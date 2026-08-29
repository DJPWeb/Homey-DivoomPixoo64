'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBaseName,
  createNameAllocator,
} = require('../lib/DeviceNaming');

test('removes legacy IP suffixes from generated names', () => {
  assert.equal(normalizeBaseName('Pixoo64 (192.168.0.114)'), 'Pixoo64');
  assert.equal(normalizeBaseName('  Office Display  '), 'Office Display');
  assert.equal(normalizeBaseName(''), 'Pixoo64');
});

test('allocates the first available numbered device name', () => {
  const allocateName = createNameAllocator([
    'Pixoo64 (192.168.0.113)',
    'pixoo64 2',
    'Pixoo64 4',
  ]);

  assert.equal(allocateName('Pixoo64'), 'Pixoo64 3');
  assert.equal(allocateName('Pixoo64'), 'Pixoo64 5');
});

test('allocates names independently for different Divoom names', () => {
  const allocateName = createNameAllocator(['Office', 'Office 2']);

  assert.equal(allocateName('Kitchen'), 'Kitchen');
  assert.equal(allocateName('Office'), 'Office 3');
  assert.equal(allocateName('Kitchen'), 'Kitchen 2');
});
