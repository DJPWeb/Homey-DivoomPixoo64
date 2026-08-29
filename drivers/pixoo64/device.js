'use strict';

const Homey    = require('homey');
const PixooApi = require('../../lib/PixooApi');
const DeviceIdentity = require('../../lib/DeviceIdentity');

// Poll interval — once per minute to detect availability and state changes
const POLL_INTERVAL_MS = 60000;
const REDISCOVERY_FAILURE_THRESHOLD = 3;
const CLOUD_REDISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
const LAN_REDISCOVERY_INTERVAL_MS = 15 * 60 * 1000;
const IDENTITY_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const CHANNEL_CAPABILITY = 'pixoo_channel';
const CHANNELS = [
  { id: 'clock', index: 0 },
  { id: 'cloud', index: 1 },
  { id: 'visualizer', index: 2 },
  { id: 'custom', index: 3 },
  { id: 'black', index: 4 },
];
const CHANNEL_BY_ID = new Map(CHANNELS.map((channel) => [channel.id, channel]));
const CHANNEL_ID_BY_INDEX = new Map(CHANNELS.map((channel) => [channel.index, channel.id]));
const CHANNEL_BUTTONS = {
  pixoo_channel_clock: 0,
  pixoo_channel_cloud: 1,
  pixoo_channel_visualizer: 2,
  pixoo_channel_custom: 3,
  pixoo_channel_black: 4,
};
const LEGACY_CHANNEL_BUTTONS = [
  'button.channel_clock',
  'button.channel_cloud',
  'button.channel_visualizer',
  'button.channel_custom',
  'button.channel_black',
];
const REQUIRED_CAPABILITIES = [
  'dim',
  CHANNEL_CAPABILITY,
  ...Object.keys(CHANNEL_BUTTONS),
];

class Pixoo64Device extends Homey.Device {

  async onInit() {
    this.log(`Pixoo64 device "${this.getName()}" initialized.`);

    this._pollFailureCount = 0;
    this._nextRecoveryAt = 0;
    this._nextLanRecoveryAt = 0;
    this._nextIdentityRefreshAt = 0;
    this._recoveryPromise = null;
    this._identityRefreshPromise = null;
    this._deleted = false;

    await this._ensureCapabilities();
    await this._syncEndpointSettings()
      .catch((err) => this.log(`API endpoint detection skipped: ${err.message}`));

    // Register on/off capability listener
    this.registerCapabilityListener('onoff', async (value) => {
      await this._setOnOff(value);
    });

    if (this.hasCapability('dim')) {
      this.registerCapabilityListener('dim', async (value) => {
        await this._setBrightness(value);
      });
    }

    if (this.hasCapability(CHANNEL_CAPABILITY)) {
      this.registerCapabilityListener(CHANNEL_CAPABILITY, async (value) => {
        await this._setChannelById(value);
      });
    }

    for (const [capabilityId, index] of Object.entries(CHANNEL_BUTTONS)) {
      if (this.hasCapability(capabilityId)) {
        this.registerCapabilityListener(capabilityId, async () => {
          await this._setChannel(index);
        });
      }
    }

    // Start availability + state sync poll
    this._startPolling();

    this._maybeRefreshIdentity(true)
      .catch((err) => this.log(`Device identity refresh skipped: ${err.message}`));

    // Sync device clock on startup (fire-and-forget)
    PixooApi.syncTime(this.getSetting('ip'))
      .catch((err) => this.log(`Initial time sync skipped: ${err.message}`));
  }

  // ─── Capability handlers ───────────────────────────────────────────────────

  async _ensureCapabilities() {
    await this._removeLegacyChannelButtons();

    for (const capabilityId of REQUIRED_CAPABILITIES) {
      if (this.hasCapability(capabilityId)) continue;

      try {
        await this.addCapability(capabilityId);
        this.log(`Added missing ${capabilityId} capability.`);
      } catch (err) {
        this.error(`Could not add ${capabilityId} capability: ${err.message}`);
      }
    }
  }

  async _removeLegacyChannelButtons() {
    if (typeof this.removeCapability !== 'function') return;

    for (const capabilityId of LEGACY_CHANNEL_BUTTONS) {
      if (!this.hasCapability(capabilityId)) continue;

      try {
        await this.removeCapability(capabilityId);
        this.log(`Removed legacy ${capabilityId} capability.`);
      } catch (err) {
        this.error(`Could not remove legacy ${capabilityId} capability: ${err.message}`);
      }
    }
  }

  async _setOnOff(on) {
    const ip = this.getSetting('ip');
    try {
      await PixooApi.setOnOff(ip, on);
      this.log(`Screen turned ${on ? 'ON' : 'OFF'}`);
    } catch (err) {
      this.error(`setOnOff failed: ${err.message}`);
      throw new Error(this.homey.__('device.command_failed'));
    }
  }

  async _setBrightness(value) {
    const ip = this.getSetting('ip');
    const numeric = Number(value);
    const normalized = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 1;
    const brightness = Math.round(normalized * 100);
    try {
      await PixooApi.setBrightness(ip, brightness);
      this.log(`Brightness set to ${brightness}%`);
    } catch (err) {
      this.error(`setBrightness failed: ${err.message}`);
      throw new Error(this.homey.__('device.command_failed'));
    }
  }

  async setChannel(index) {
    await this._setChannel(index);
  }

  async _setChannel(index) {
    const channelIndex = parseInt(index, 10);
    if (!CHANNEL_ID_BY_INDEX.has(channelIndex)) {
      throw new Error(this.homey.__('device.command_failed'));
    }

    const ip = this.getSetting('ip');
    try {
      await PixooApi.setChannel(ip, channelIndex);
      await this._syncChannelCapability(channelIndex);
      this.log(`Channel switched to ${CHANNEL_ID_BY_INDEX.get(channelIndex)}.`);
    } catch (err) {
      this.error(`setChannel failed: ${err.message}`);
      throw new Error(this.homey.__('device.command_failed'));
    }
  }

  async _setChannelById(channelId) {
    const channel = CHANNEL_BY_ID.get(channelId);
    if (!channel) {
      throw new Error(this.homey.__('device.command_failed'));
    }
    await this._setChannel(channel.index);
  }

  async _syncChannelCapability(index = null) {
    if (!this.hasCapability(CHANNEL_CAPABILITY)) return;

    const channelIndex = index === null
      ? await PixooApi.getChannel(this.getSetting('ip'))
      : parseInt(index, 10);
    const channelId = CHANNEL_ID_BY_INDEX.get(channelIndex);
    if (!channelId) return;

    if (this.getCapabilityValue(CHANNEL_CAPABILITY) !== channelId) {
      await this.setCapabilityValue(CHANNEL_CAPABILITY, channelId);
      this.log(`Channel synced: ${channelId}`);
    }
  }

  async _syncEndpointSettings(ip = this.getSetting('ip'), endpoint = null) {
    const currentIp = PixooApi.normalizeIpInput(ip);
    if (!currentIp) return null;

    const detected = endpoint || await PixooApi.resolveEndpoint(currentIp);
    const settings = PixooApi.endpointSettings(currentIp, detected);
    if (
      this.getSetting('api_revision') !== settings.api_revision
      || this.getSetting('api_endpoint') !== settings.api_endpoint
    ) {
      await this.setSettings(settings);
      this.log(`API endpoint detected: ${detected.label}`);
    }
    return detected;
  }

  _getStoredIdentity() {
    return {
      deviceId:  this.getStoreValue(DeviceIdentity.STORE_KEYS.deviceId),
      deviceMac: this.getStoreValue(DeviceIdentity.STORE_KEYS.deviceMac),
      hardware:  this.getStoreValue(DeviceIdentity.STORE_KEYS.hardware),
    };
  }

  async _storeDeviceIdentity(device) {
    const store = DeviceIdentity.toStore(device);
    let changed = false;

    for (const [key, value] of Object.entries(store)) {
      if (this.getStoreValue(key) === value) continue;
      await this.setStoreValue(key, value);
      changed = true;
    }

    if (changed) {
      const identity = this._getStoredIdentity();
      const fields = [
        identity.deviceMac ? 'MAC' : null,
        identity.deviceId ? 'device ID' : null,
      ].filter(Boolean).join(' and ');
      this.log(`Divoom identity stored${fields ? ` (${fields})` : ''}.`);
    }
  }

  async _clearStoredIdentity() {
    if (typeof this.unsetStoreValue !== 'function') return;

    for (const key of Object.values(DeviceIdentity.STORE_KEYS)) {
      if (this.getStoreValue(key) === undefined) continue;
      await this.unsetStoreValue(key);
    }
  }

  async _maybeRefreshIdentity(force = false, ipOverride = null) {
    const stored = this._getStoredIdentity();
    if (stored.deviceMac && stored.deviceId) return stored;
    if (this._identityRefreshPromise) return this._identityRefreshPromise;

    const now = Date.now();
    if (!force && now < this._nextIdentityRefreshAt) return stored;
    this._nextIdentityRefreshAt = now + IDENTITY_REFRESH_INTERVAL_MS;

    const ip = PixooApi.normalizeIpInput(ipOverride || this.getSetting('ip'));
    this._identityRefreshPromise = (async () => {
      const discovered = await PixooApi.findCloudDeviceByIp(ip);
      if (discovered) await this._storeDeviceIdentity(discovered);
      return this._getStoredIdentity();
    })().finally(() => {
      this._identityRefreshPromise = null;
    });

    return this._identityRefreshPromise;
  }

  _getPairedDeviceCount() {
    try {
      const devices = this.driver.getDevices();
      return Array.isArray(devices) ? devices.length : 2;
    } catch (_) {
      return 2;
    }
  }

  async _getRecoverySubnets(currentIp) {
    const subnets = new Set();
    const currentSubnet = PixooApi.subnetFromIp(currentIp);
    if (currentSubnet) subnets.add(currentSubnet);

    try {
      const localIp = await this.homey.cloud.getLocalAddress();
      const localSubnet = PixooApi.subnetFromIp(localIp);
      if (localSubnet) subnets.add(localSubnet);
    } catch (_) {}

    return [...subnets];
  }

  async _maybeRecoverIp() {
    if (
      this._deleted
      || this._pollFailureCount < REDISCOVERY_FAILURE_THRESHOLD
      || this._recoveryPromise
    ) {
      return false;
    }

    const now = Date.now();
    const scanLan = now >= this._nextLanRecoveryAt;
    if (now < this._nextRecoveryAt && !scanLan) return false;

    this._nextRecoveryAt = now + CLOUD_REDISCOVERY_INTERVAL_MS;
    if (scanLan) this._nextLanRecoveryAt = now + LAN_REDISCOVERY_INTERVAL_MS;

    this._recoveryPromise = this._recoverIp(scanLan)
      .finally(() => {
        this._recoveryPromise = null;
      });

    return this._recoveryPromise;
  }

  async _recoverIp(scanLan) {
    const currentIp = PixooApi.normalizeIpInput(this.getSetting('ip'));
    await this._maybeRefreshIdentity(true, currentIp)
      .catch((err) => this.log(`Identity refresh during recovery skipped: ${err.message}`));

    const identity = this._getStoredIdentity();
    const allowSingleCandidate = this._getPairedDeviceCount() === 1;
    const subnets = scanLan ? await this._getRecoverySubnets(currentIp) : [];

    this.log(
      `Automatic IP recovery started for ${currentIp}`
      + `${DeviceIdentity.hasIdentity(identity) ? ' using stored identity' : ' without stored identity'}.`,
    );

    const recovered = await PixooApi.rediscoverDevice({
      currentIp,
      deviceId: identity.deviceId,
      deviceMac: identity.deviceMac,
      allowSingleCandidate,
      scanLan,
      subnets,
    });

    if (!recovered || this._deleted) {
      this.log(`Automatic IP recovery found no verified replacement for ${currentIp}.`);
      return false;
    }

    const recoveredIp = PixooApi.normalizeIpInput(recovered.ip);
    if (!isValidIp(recoveredIp)) return false;

    const configuredIp = PixooApi.normalizeIpInput(this.getSetting('ip'));
    if (configuredIp !== currentIp) {
      this.log(`Automatic IP recovery aborted because the configured IP changed to ${configuredIp}.`);
      return false;
    }

    await this._storeDeviceIdentity(recovered);
    const endpointSettings = PixooApi.endpointSettings(recoveredIp, recovered.endpoint);

    if (recoveredIp !== currentIp) {
      await this.setSettings({
        ip: recoveredIp,
        ...endpointSettings,
      });
      PixooApi.forgetDevice(currentIp);
      this.log(`IP address automatically updated: ${currentIp} -> ${recoveredIp}`);
    } else {
      await this._syncEndpointSettings(recoveredIp, recovered.endpoint);
      this.log(`Automatic IP recovery verified the existing address ${recoveredIp}.`);
    }

    this._pollFailureCount = 0;
    this._nextRecoveryAt = 0;
    this._nextLanRecoveryAt = 0;

    if (!this.getAvailable()) await this.setAvailable();

    PixooApi.syncTime(recoveredIp)
      .catch((err) => this.log(`Time sync after IP recovery skipped: ${err.message}`));
    this.homey.setTimeout(() => {
      this._poll().catch((err) => this.error(`Post-recovery poll error: ${err.message}`));
    }, 0);

    return true;
  }

  // ─── Availability + state polling ─────────────────────────────────────────

  _startPolling() {
    this._stopPolling();

    this._pollInterval = this.homey.setInterval(() => {
      this._poll().catch((err) => this.error(`Poll error: ${err.message}`));
    }, POLL_INTERVAL_MS);

    // First poll immediately
    this._poll().catch((err) => this.error(`Initial poll error: ${err.message}`));
  }

  _stopPolling() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  async _poll() {
    const ip = this.getSetting('ip');
    try {
      const { on, brightness } = await PixooApi.getScreenState(ip);
      await this._syncEndpointSettings(ip);
      this._pollFailureCount = 0;
      this._nextRecoveryAt = 0;
      this._nextLanRecoveryAt = 0;

      this._maybeRefreshIdentity()
        .catch((err) => this.log(`Device identity refresh skipped: ${err.message}`));

      // Sync onoff state if it changed physically
      if (this.getCapabilityValue('onoff') !== on) {
        await this.setCapabilityValue('onoff', on);
        this.log(`State synced: screen is ${on ? 'ON' : 'OFF'}`);
      }

      if (this.hasCapability('dim')) {
        const dim = Math.max(0, Math.min(1, brightness / 100));
        const currentDim = this.getCapabilityValue('dim');
        if (typeof currentDim !== 'number' || Math.abs(currentDim - dim) > 0.005) {
          await this.setCapabilityValue('dim', dim);
          this.log(`Brightness synced: ${brightness}%`);
        }
      }

      await this._syncChannelCapability()
        .catch((err) => this.log(`Channel sync skipped: ${err.message}`));

      // Restore availability if the device was previously offline
      if (!this.getAvailable()) {
        await this.setAvailable();
        this.log('Device is back online.');
        // Re-sync clock after reconnection (fire-and-forget)
        PixooApi.syncTime(this.getSetting('ip'))
          .catch((err) => this.log(`Time sync on reconnect skipped: ${err.message}`));
      }
    } catch (err) {
      this._pollFailureCount += 1;
      this.error(`Pixoo64 unreachable at ${ip}: ${err.message}`);
      if (this.getAvailable()) {
        await this.setUnavailable(this.homey.__('device.unreachable'));
      }
      if (this._pollFailureCount >= REDISCOVERY_FAILURE_THRESHOLD) {
        this._maybeRecoverIp()
          .catch((recoveryErr) => this.error(`Automatic IP recovery failed: ${recoveryErr.message}`));
      }
    }
  }

  // ─── Settings changes ──────────────────────────────────────────────────────

  async onSettings({ newSettings, changedKeys }) {
    const managedSettingChanged = changedKeys.some((key) => key === 'api_revision' || key === 'api_endpoint');

    if (changedKeys.includes('ip')) {
      const oldIp = PixooApi.normalizeIpInput(this.getSetting('ip'));
      const newIp = PixooApi.normalizeIpInput(newSettings.ip);
      if (!isValidIp(newIp)) {
        throw new Error(this.homey.__('pairing.invalid_ip'));
      }
      this.log(`IP address changed to: ${newIp}`);
      try {
        const endpoint = await PixooApi.resolveEndpoint(newIp);
        if (oldIp && oldIp !== newIp) PixooApi.forgetDevice(oldIp);
        await this._syncEndpointSettings(newIp, endpoint);
        if (newSettings.ip !== newIp) await this.setSettings({ ip: newIp });
        if (oldIp !== newIp) {
          if (this._identityRefreshPromise) {
            await this._identityRefreshPromise.catch(() => null);
          }
          await this._clearStoredIdentity();
        }
        this._pollFailureCount = 0;
        this._nextRecoveryAt = 0;
        this._nextLanRecoveryAt = 0;
        this._nextIdentityRefreshAt = 0;
        this._maybeRefreshIdentity(true, newIp)
          .catch((identityErr) => this.log(`Device identity refresh skipped: ${identityErr.message}`));
        this._startPolling(); // restart poll with new IP immediately
        await this.setAvailable();
        this.homey.setTimeout(() => {
          this._syncEndpointSettings()
            .catch((err) => this.log(`API endpoint setting refresh skipped: ${err.message}`));
        }, 0);
      } catch (err) {
        throw new Error(this.homey.__('pairing.unreachable', { ip: newIp }));
      }
    } else if (managedSettingChanged) {
      this.homey.setTimeout(() => {
        this._syncEndpointSettings()
          .catch((err) => this.log(`API endpoint setting restore skipped: ${err.message}`));
      }, 0);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onDeleted() {
    this._deleted = true;
    this._stopPolling();
    const ip = String(this.getSetting('ip') || '').trim();
    const normalizedIp = PixooApi.normalizeIpInput(ip);
    if (normalizedIp) PixooApi.forgetDevice(normalizedIp);
    this.log('Device deleted — polling stopped.');
  }

}

function isValidIp(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)
    && ip.split('.').every((octet) => parseInt(octet, 10) <= 255);
}

module.exports = Pixoo64Device;
