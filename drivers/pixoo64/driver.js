'use strict';

const Homey    = require('homey');
const PixooApi = require('../../lib/PixooApi');
const DeviceIdentity = require('../../lib/DeviceIdentity');
const DeviceNaming = require('../../lib/DeviceNaming');
const crypto   = require('crypto');

class Pixoo64Driver extends Homey.Driver {

  async onInit() {
    this.log('Pixoo64 driver initialized.');
  }

  /**
   * onPair handles all pairing flows:
   *   - 'discover'     : start.html triggers LAN scan, returns device list
   *   - 'validate_ip'  : ip_input.html validates a manually entered IP
   *   - 'get_device'   : ip_input.html retrieves the pending device descriptor
   */
  async onPair(session) {
    let pendingDevice = null;

    // ── Auto-discovery ─────────────────────────────────────────────────────
    session.setHandler('discover', async () => {
      // Try Homey's own local IP first — most reliable on Homey Pro.
      // discoverDevices() will fall back to UDP routing trick then os.networkInterfaces().
      let subnetHint = null;
      try {
        const localIp = await this.homey.cloud.getLocalAddress();
        if (localIp && typeof localIp === 'string') {
          const parts = localIp.split('.');
          if (parts.length >= 3) subnetHint = `${parts[0]}.${parts[1]}.${parts[2]}`;
        }
      } catch (_) { /* not available on this firmware — that's fine */ }

      this.log(`Discovery: subnetHint from Homey API = ${subnetHint || 'none (will auto-detect)'}`);

      // Tell the view what we're about to do (shown in the loading screen).
      try { session.emit('scan_info', { subnet: subnetHint || 'cloud' }); } catch (_) {}

      try {
        const found = await PixooApi.discoverDevices(subnetHint);
        const allocateName = DeviceNaming.createNameAllocator(
          this.getDevices().map((device) => device.getName()),
        );
        this.log(`Discovery: ${found.length} device(s): ${found.map((d) => `${d.ip}/${d.endpoint.mode}`).join(', ') || 'none'}`);
        return found.map((device) => {
          const { ip, name, endpoint } = device;
          return {
            name: allocateName(name),
            data: { id: `pixoo64-${crypto.randomBytes(4).toString('hex')}` },
            store: DeviceIdentity.toStore(device),
            settings: {
              ip,
              ...PixooApi.endpointSettings(ip, endpoint),
            },
          };
        });
      } catch (err) {
        this.error(`Discovery error: ${err.message}`);
        return [];
      }
    });

    // ── Manual IP flow ─────────────────────────────────────────────────────

    // Step 1 — validate IP and reach the physical device
    session.setHandler('validate_ip', async (ip) => {
      ip = PixooApi.normalizeIpInput(ip);

      if (!isValidIp(ip)) {
        throw new Error(this.homey.__('pairing.invalid_ip'));
      }

      let endpoint = null;
      let identity = null;
      try {
        endpoint = await PixooApi.resolveEndpoint(ip);
        identity = await PixooApi.findCloudDeviceByIp(ip)
          .catch(() => null);
      } catch (err) {
        this.error(`Could not reach Pixoo64 at ${ip}: ${err.message}`);
        throw new Error(this.homey.__('pairing.unreachable', { ip }));
      }

      // data.id is a stable random hex — never the IP (IP can change, data is immutable)
      const allocateName = DeviceNaming.createNameAllocator(
        this.getDevices().map((device) => device.getName()),
      );
      pendingDevice = {
        name: allocateName(identity?.name),
        data: {
          id: `pixoo64-${crypto.randomBytes(4).toString('hex')}`,
        },
        store: DeviceIdentity.toStore(identity || {}),
        settings: {
          ip,
          ...PixooApi.endpointSettings(ip, endpoint),
        },
      };

      return {
        success:  true,
        message:  endpoint.label,
        revision: endpoint.revision,
        endpoint: endpoint.url,
      };
    });

    // Step 2 — return the prepared device object to the HTML view
    session.setHandler('get_device', async () => {
      if (!pendingDevice) {
        throw new Error(this.homey.__('pairing.not_validated'));
      }
      return pendingDevice;
    });

  }

}

/**
 * Basic IPv4 format validation.
 * @param {string} ip
 * @returns {boolean}
 */
function isValidIp(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)
    && ip.split('.').every((octet) => parseInt(octet, 10) <= 255);
}

module.exports = Pixoo64Driver;
