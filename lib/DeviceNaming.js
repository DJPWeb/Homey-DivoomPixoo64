'use strict';

const IP_SUFFIX_PATTERN = /\s*\((?:\d{1,3}\.){3}\d{1,3}\)\s*$/;

function normalizeBaseName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(IP_SUFFIX_PATTERN, '')
    .trim();
  return normalized || 'Pixoo64';
}

function createNameAllocator(existingNames = []) {
  const usedNames = [...existingNames];

  return (baseName) => {
    const base = normalizeBaseName(baseName);
    const escapedBase = escapeRegExp(base);
    const numberedNamePattern = new RegExp(`^${escapedBase}\\s+(\\d+)$`, 'i');
    const occupiedNumbers = new Set();

    for (const usedName of usedNames) {
      const normalizedUsedName = normalizeBaseName(usedName);
      if (normalizedUsedName.localeCompare(base, undefined, { sensitivity: 'accent' }) === 0) {
        occupiedNumbers.add(1);
        continue;
      }

      const match = normalizedUsedName.match(numberedNamePattern);
      if (match) occupiedNumbers.add(Number(match[1]));
    }

    let suffix = 1;
    while (occupiedNumbers.has(suffix)) suffix += 1;

    const name = suffix === 1 ? base : `${base} ${suffix}`;
    usedNames.push(name);
    return name;
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  normalizeBaseName,
  createNameAllocator,
};
