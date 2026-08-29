'use strict';

/**
 * PixooApi
 *
 * Thin wrapper around the Pixoo64 local HTTP API.
 * Uses Node's built-in `http` module — zero npm dependencies.
 *
 * All commands are POSTed as JSON to the device's local API endpoint.
 * Legacy devices use http://<ip>:80/post; newer revisions use
 * http://<ip>:9000/divoom_api.
 */

const http         = require('http');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const dgram        = require('dgram');
const zlib         = require('zlib');
const ImageDecoder = require('./ImageDecoder');
const PixelFont    = require('./PixelFont');
const DeviceIdentity = require('./DeviceIdentity');

// Directory where bundled PNG/GIF images are stored inside the app package
const LOCAL_IMAGES_DIR = path.join(__dirname, '..', 'assets', 'display');

const TIMEOUT_MS    = 5000;
const SCAN_TIMEOUT  = 2000;

const API_ENDPOINTS = [
  {
    mode:     'legacy',
    revision: 'Legacy revision',
    label:    'Pixoo64 Legacy Revision Detected',
    port:     80,
    path:     '/post',
  },
  {
    mode:     'new',
    revision: 'New revision',
    label:    'Pixoo64 New Revision Detected',
    port:     9000,
    path:     '/divoom_api',
  },
];

const ENDPOINT_PROBE_PAYLOADS = [
  { Command: 'Channel/GetAllConf' },
  { Command: 'Channel/GetIndex' },
];
const _endpointCache = new Map();

const CLOUD_DISCOVERY_CACHE_MS = 30000;
const SUBNET_SCAN_CACHE_MS = 60000;
const _cloudDiscoveryCache = { ts: 0, devices: [] };
let _cloudDiscoveryPromise = null;
const _subnetScanCache = new Map();
const _subnetScanPromises = new Map();

/**
 * Low-level POST to a concrete Pixoo64 endpoint.
 * Resolves with the parsed JSON response.
 * Rejects on network error, timeout, or unparseable response.
 * Does NOT reject on error_code — callers decide what to do with it.
 * @param {string} ip
 * @param {object} endpoint
 * @param {object} payload
 * @param {number} [timeoutMs]
 * @param {object|boolean} [agent]  Pass `false` to bypass connection pooling (used for scanning)
 * @returns {Promise<object>}
 */
function _postToEndpoint(ip, endpoint, payload, timeoutMs = TIMEOUT_MS, agent = undefined) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const body = JSON.stringify(payload);

    const options = {
      hostname: ip,
      port:     endpoint.port,
      path:     endpoint.path,
      method:   'POST',
      agent,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          done(resolve, JSON.parse(raw));
        } catch (_) {
          done(reject, new Error(`Unparseable response from ${_endpointUrl(ip, endpoint)}: ${raw}`));
        }
      });
      res.on('error', (err) => done(reject, err));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request to ${_endpointUrl(ip, endpoint)} timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => done(reject, err));
    req.write(body);
    req.end();
  });
}

function _endpointUrl(ip, endpoint) {
  return `http://${ip}:${endpoint.port}${endpoint.path}`;
}

function normalizeIpInput(input) {
  const value = String(input || '').trim();
  if (!value) return '';

  try {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`);
    return parsed.hostname;
  } catch (_) {
    return value.split('/')[0].split(':')[0].trim();
  }
}

function _publicEndpoint(ip, endpoint) {
  return {
    mode:     endpoint.mode,
    revision: endpoint.revision,
    label:    endpoint.label,
    port:     endpoint.port,
    path:     endpoint.path,
    url:      _endpointUrl(ip, endpoint),
  };
}

function _endpointSettings(ip, endpoint) {
  return {
    api_revision: endpoint.revision,
    api_endpoint: _endpointUrl(ip, endpoint),
  };
}

function _pixooProbeScore(res) {
  if (!res || typeof res !== 'object') return 0;
  if (
    res.LightSwitch !== undefined
    || res.Brightness !== undefined
    || res.SelectIndex !== undefined
  ) {
    return 3;
  }
  if (String(res.error_code) === '0') return 2;
  return 0;
}

async function _probeEndpoint(ip, endpoint, timeoutMs = SCAN_TIMEOUT, agent = undefined) {
  let lastResponse = null;
  let bestScore = 0;
  for (const payload of ENDPOINT_PROBE_PAYLOADS) {
    const res = await _postToEndpoint(ip, endpoint, payload, timeoutMs, agent);
    const score = _pixooProbeScore(res);
    if (score > bestScore) bestScore = score;
    if (score >= 3) {
      return { endpoint, score };
    }
    lastResponse = res;
  }

  if (bestScore > 0) return { endpoint, score: bestScore };

  const suffix = lastResponse ? ` Response: ${JSON.stringify(lastResponse).slice(0, 160)}` : '';
  throw new Error(`Unsupported Pixoo64 API response from ${_endpointUrl(ip, endpoint)}.${suffix}`);
}

/**
 * Detect and cache the local API endpoint used by a Pixoo64.
 * @param {string} ip
 * @param {number} [timeoutMs]
 * @param {object|boolean} [agent]
 * @param {{force?: boolean, skipMode?: string}} [options]
 * @returns {Promise<{mode:string,revision:string,label:string,port:number,path:string,url:string}>}
 */
async function resolveEndpoint(ip, timeoutMs = SCAN_TIMEOUT, agent = undefined, options = {}) {
  ip = normalizeIpInput(ip);
  const cached = _endpointCache.get(ip);
  if (!options.force && cached && cached.mode !== options.skipMode) {
    return _publicEndpoint(ip, cached);
  }

  let lastError = null;
  let bestProbe = null;
  for (const endpoint of API_ENDPOINTS) {
    if (endpoint.mode === options.skipMode) continue;
    try {
      const detected = await _probeEndpoint(ip, endpoint, timeoutMs, agent);
      if (!bestProbe || detected.score > bestProbe.score) bestProbe = detected;
      if (detected.score >= 3) {
        _endpointCache.set(ip, detected.endpoint);
        return _publicEndpoint(ip, detected.endpoint);
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (bestProbe && bestProbe.score >= 2) {
    _endpointCache.set(ip, bestProbe.endpoint);
    return _publicEndpoint(ip, bestProbe.endpoint);
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`No supported Pixoo64 API endpoint reachable at ${ip}.${suffix}`);
}

function endpointSettings(ip, endpointInfo = null) {
  ip = normalizeIpInput(ip);
  const endpoint = endpointInfo || _endpointCache.get(ip);
  if (!endpoint) {
    return {
      api_revision: 'Unknown',
      api_endpoint: '',
    };
  }
  return _endpointSettings(ip, endpoint);
}

/**
 * POST to the detected Pixoo64 endpoint, falling back to the alternate endpoint
 * if the cached endpoint stops responding.
 * @param {string} ip
 * @param {object} payload
 * @param {number} [timeoutMs]
 * @param {object|boolean} [agent]
 * @returns {Promise<object>}
 */
async function post(ip, payload, timeoutMs = TIMEOUT_MS, agent = undefined) {
  ip = normalizeIpInput(ip);
  const endpoint = await resolveEndpoint(ip, timeoutMs, agent);
  try {
    return await _postToEndpoint(ip, endpoint, payload, timeoutMs, agent);
  } catch (_) {
    _endpointCache.delete(ip);
    const fallback = await resolveEndpoint(ip, timeoutMs, agent, {
      force:    true,
      skipMode: endpoint.mode,
    });
    return _postToEndpoint(ip, fallback, payload, timeoutMs, agent);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Ping the device and return its full configuration.
 * Accepts ANY valid JSON response regardless of error_code — some firmware
 * versions return error_code:1 for certain commands while still being alive.
 * @param {string} ip
 * @returns {Promise<void>}
 */
async function getDeviceInfo(ip) {
  await post(ip, { Command: 'Channel/GetIndex' });
}

/**
 * Get the current screen on/off state and brightness.
 * Returns { on: boolean, brightness: number 0-100 }
 * @param {string} ip
 * @returns {Promise<{on: boolean, brightness: number}>}
 */
async function getScreenState(ip) {
  const res = await post(ip, { Command: 'Channel/GetAllConf' });
  const lightSwitch = Number(res.LightSwitch);
  const brightness  = Number(res.Brightness);
  return {
    // LightSwitch: 1 = on, 0 = off (default to true if field absent)
    on:         res.LightSwitch !== undefined ? lightSwitch === 1 : true,
    // Brightness: 0-100 (default to 100 if field absent)
    brightness: Number.isFinite(brightness) ? brightness : 100,
  };
}

/**
 * Turn the screen on or off.
 * @param {string} ip
 * @param {boolean} on
 * @returns {Promise<void>}
 */
async function setOnOff(ip, on) {
  const res = await post(ip, {
    Command: 'Channel/OnOffScreen',
    OnOff:   on ? 1 : 0,
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`OnOffScreen failed with error_code ${res.error_code}`);
  }
}

/**
 * Set screen brightness.
 * @param {string} ip
 * @param {number} brightness  0–100
 * @returns {Promise<void>}
 */
async function setBrightness(ip, brightness) {
  const value = Math.round(Math.min(100, Math.max(0, brightness)));
  const res = await post(ip, {
    Command:    'Channel/SetBrightness',
    Brightness: value,
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`SetBrightness failed with error_code ${res.error_code}`);
  }
}

// ─── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Query Divoom's cloud endpoint and cache its device identity records briefly.
 * Concurrent callers share the same request.
 * @param {{force?: boolean}} [options]
 * @returns {Promise<Array<{ip:string,name:string,deviceId:string|null,deviceMac:string|null,hardware:*}>>}
 */
async function discoverCloudDevices(options = {}) {
  const now = Date.now();
  if (
    !options.force
    && _cloudDiscoveryCache.ts > 0
    && now - _cloudDiscoveryCache.ts < CLOUD_DISCOVERY_CACHE_MS
  ) {
    return _cloudDiscoveryCache.devices.map((device) => ({ ...device }));
  }

  if (_cloudDiscoveryPromise) return _cloudDiscoveryPromise;

  _cloudDiscoveryPromise = _fetchCloudDevices()
    .then((devices) => {
      _cloudDiscoveryCache.ts = Date.now();
      _cloudDiscoveryCache.devices = devices;
      return devices.map((device) => ({ ...device }));
    })
    .finally(() => {
      _cloudDiscoveryPromise = null;
    });

  return _cloudDiscoveryPromise;
}

async function findCloudDeviceByIp(ip, options = {}) {
  const normalizedIp = normalizeIpInput(ip);
  const devices = await discoverCloudDevices(options);
  const matches = devices.filter((device) => device.ip === normalizedIp);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Scan for devices, preferring Divoom's cloud identity list and falling back
 * to the local /24 subnet.
 * @param {string|null} [subnetHint] x.y.z prefix
 * @returns {Promise<Array<object>>}
 */
async function discoverDevices(subnetHint = null) {
  try {
    const cloud = await discoverCloudDevices();
    if (cloud.length > 0) {
      const resolved = await Promise.allSettled(
        cloud.map((device) => _probePixoo(device.ip, device)),
      );
      const found = resolved
        .filter((result) => result.status === 'fulfilled' && result.value !== null)
        .map((result) => result.value);
      if (found.length > 0) return found;
    }
  } catch (_) {}

  try {
    const subnet = normalizeSubnet(subnetHint)
      || (await _getLocalIp().then(subnetFromIp))
      || normalizeSubnet(_getLocalSubnet());
    if (!subnet) return [];
    return await scanSubnet(subnet);
  } catch (_) {
    return [];
  }
}

/**
 * Find the same physical Pixoo at its current address.
 * A stored MAC or Device ID is always preferred. The single-candidate fallback
 * is allowed only for devices that do not have a persistent identity yet.
 * @param {object} options
 * @returns {Promise<object|null>}
 */
async function rediscoverDevice(options = {}) {
  const currentIp = normalizeIpInput(options.currentIp);
  const identity = {
    deviceId:  options.deviceId,
    deviceMac: options.deviceMac,
  };
  const identityKnown = DeviceIdentity.hasIdentity(identity);
  const cloud = await discoverCloudDevices({ force: true });

  let candidate = DeviceIdentity.findIdentityMatch(cloud, identity);
  if (!identityKnown) {
    const currentMatches = cloud.filter((device) => device.ip === currentIp);
    if (currentMatches.length === 1) {
      [candidate] = currentMatches;
    } else if (options.allowSingleCandidate && cloud.length === 1) {
      [candidate] = cloud;
    }
  }

  if (candidate) {
    const found = await _probePixoo(candidate.ip, candidate);
    if (found) return found;
    if (identityKnown) return null;
  }

  if (identityKnown || !options.scanLan || !options.allowSingleCandidate) {
    return null;
  }

  const subnets = [...new Set(
    (Array.isArray(options.subnets) ? options.subnets : [])
      .map(normalizeSubnet)
      .filter(Boolean),
  )];
  const discovered = [];

  for (const subnet of subnets) {
    const found = await scanSubnet(subnet, { timeoutMs: 1000 });
    discovered.push(...found);
  }

  const uniqueByIp = new Map();
  for (const device of discovered) uniqueByIp.set(device.ip, device);
  const unique = [...uniqueByIp.values()];
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Scan a /24 subnet with shared promises and a short cache.
 * @param {string} subnet
 * @param {{force?:boolean,timeoutMs?:number}} [options]
 * @returns {Promise<Array<object>>}
 */
async function scanSubnet(subnet, options = {}) {
  subnet = normalizeSubnet(subnet);
  if (!subnet) return [];

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(250, Math.round(options.timeoutMs))
    : SCAN_TIMEOUT;
  const cacheKey = `${subnet}:${timeoutMs}`;
  const cached = _subnetScanCache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.ts < SUBNET_SCAN_CACHE_MS) {
    return cached.devices.map((device) => ({ ...device }));
  }

  if (_subnetScanPromises.has(cacheKey)) return _subnetScanPromises.get(cacheKey);

  const promise = (async () => {
    const batchSize = 40;
    const candidates = Array.from({ length: 254 }, (_, index) => `${subnet}.${index + 1}`);
    const found = [];

    for (let index = 0; index < candidates.length; index += batchSize) {
      const batch = candidates.slice(index, index + batchSize);
      const results = await Promise.allSettled(
        batch.map((ip) => _probePixoo(ip, undefined, timeoutMs)),
      );
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value !== null) {
          found.push(result.value);
        }
      }
    }

    _subnetScanCache.set(cacheKey, { ts: Date.now(), devices: found });
    return found.map((device) => ({ ...device }));
  })().finally(() => {
    _subnetScanPromises.delete(cacheKey);
  });

  _subnetScanPromises.set(cacheKey, promise);
  return promise;
}

function normalizeSubnet(value) {
  if (!value) return null;
  const parts = String(value).trim().split('.');
  if (parts.length === 4) parts.pop();
  if (
    parts.length !== 3
    || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return null;
  }
  return parts.map((part) => String(Number(part))).join('.');
}

function subnetFromIp(ip) {
  return normalizeSubnet(normalizeIpInput(ip));
}

/**
 * Query Divoom's cloud endpoint to get device identity and local IP records.
 * @returns {Promise<Array<object>>}
 */
function _fetchCloudDevices() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'app.divoom-gz.com',
      path:     '/Device/ReturnSameLANDevice',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': 0,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data',  (chunk) => { raw += chunk; });
      res.on('error', ()      => resolve([]));
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.ReturnCode === 0 && Array.isArray(data.DeviceList)) {
            resolve(
              data.DeviceList
                .map(DeviceIdentity.normalizeDiscoveredDevice)
                .filter((device) => device.ip),
            );
          } else {
            resolve([]);
          }
        } catch (_) {
          resolve([]);
        }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
    req.end();
  });
}

/**
 * Try to identify a Pixoo64 at the given IP.
 * Returns { ip, name, endpoint } on success, null otherwise.
 * Never rejects.
 * Uses agent:false to keep each scan socket independent of the global pool,
 * which prevents internal state issues under the 254-concurrent-requests load.
 * @param {string} ip
 * @param {object|string} [metadata]
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>}
 */
async function _probePixoo(ip, metadata = undefined, timeoutMs = SCAN_TIMEOUT) {
  try {
    const endpoint = await resolveEndpoint(ip, timeoutMs, false, { force: true });
    const device = DeviceIdentity.normalizeDiscoveredDevice(
      typeof metadata === 'string' ? { ip, name: metadata } : { ...metadata, ip },
    );
    return { ...device, endpoint };
  } catch (_) {
    return null;
  }
}

/**
 * Get the local LAN IP by routing a UDP socket toward 8.8.8.8.
 * No data is ever sent — the OS just assigns the source address.
 * This is the most reliable way to find the outbound LAN IP on any platform.
 * @returns {Promise<string|null>}
 */
function _getLocalIp() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.connect(80, '8.8.8.8', () => {
      let addr = null;
      try { addr = s.address().address; } catch (_) {}
      try { s.close(); } catch (_) {}
      resolve(addr);
    });
    s.on('error', () => {
      try { s.close(); } catch (_) {}
      resolve(null);
    });
  });
}

/**
 * Convert an IP address string to its x.y.z subnet prefix, or null.
 * @param {string|null} ip
 * @returns {string|null}
 */
function _toSubnet(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const parts = ip.split('.');
  return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}` : null;
}

/**
 * Return the x.y.z prefix of the first non-loopback IPv4 address via
 * os.networkInterfaces() — fallback when UDP routing trick is unavailable.
 * Handles both Node.js < 18 (family: 'IPv4') and >= 18 (family: 4).
 * @returns {string|null}
 */
function _getLocalSubnet() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    if (!Array.isArray(iface)) continue;
    for (const net of iface) {
      if (!net) continue;
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal && net.address) {
        return _toSubnet(net.address);
      }
    }
  }
  return null;
}

// ─── Image display ─────────────────────────────────────────────────────────────

const IMAGE_CACHE_TTL  = 5 * 60 * 1000; // 5 minutes
const MAX_ANIM_FRAMES  = 60; // Pixoo64 firmware limit for Draw/SendHttpGif PicNum
const ANIMATION_MODE_DEFAULT = 'timing';
const ANIMATION_MODES = new Set(['balanced', 'fast', 'slow', 'timing']);
const MAX_FRAME_CACHE_ENTRIES = 64;
const MAX_RAW_IMAGE_CACHE_ENTRIES = 64;
const MAX_LAMETRIC_CACHE_ENTRIES = 256;
const MAX_LOCAL_IMAGE_CACHE_ENTRIES = 64;
const MAX_DEVICE_STATE_ENTRIES = 64;
const CANVAS_WRITE_DEBOUNCE_MS = 300;

function _touchMap(map, key, value, maxEntries = Infinity) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function _pruneTtlCache(map, ttlMs) {
  const now = Date.now();
  for (const [k, v] of map) {
    if (!v || typeof v.ts !== 'number' || now - v.ts > ttlMs) {
      map.delete(k);
    }
  }
}

// Multi-frame cache: url → { frames: [{picData: base64, delayMs}], ts }
const _frameCache = new Map();

// Per-IP send queue: at most one request in flight + one pending slot (last-wins).
// The Pixoo64's embedded HTTP server handles one request at a time; sending
// concurrent Draw/SendHttpGif commands causes the device to drop intermediate
// ones.  The last-wins strategy ensures the device always ends up showing the
// most recently requested image, discarding intermediate ones silently.
const _sending = new Map(); // ip → Promise  (currently executing send)
const _pending = new Map(); // ip → { picData, resolve, reject }

// Per-IP drawing canvas: persists across drawRect / drawImageAt / fillScreen calls
// so that each primitive layers on top of the previous one (like a retained canvas).
// fillScreen replaces it; drawRect and drawImageAt composite onto it.
// The canvas is also saved to disk so it survives app restarts.
const _drawCanvas = new Map(); // ip → Buffer (64*64*3 bytes, in-memory cache)
const _canvasWriteTimers = new Map(); // ip → Timeout
const _canvasWriteLatest = new Map(); // ip → Buffer

const CANVAS_BYTES = 64 * 64 * 3; // 12 288 bytes per canvas

/** Sanitize an IP string into a safe filename component. */
const _canvasPath = (ip) =>
  path.join('/userdata', 'px64_' + ip.replace(/\./g, '-') + '.bin');

function _scheduleCanvasPersist(ip, canvas) {
  _touchMap(_canvasWriteLatest, ip, Buffer.from(canvas), MAX_DEVICE_STATE_ENTRIES);

  const pending = _canvasWriteTimers.get(ip);
  if (pending) clearTimeout(pending);

  const timer = setTimeout(async () => {
    _canvasWriteTimers.delete(ip);
    const latest = _canvasWriteLatest.get(ip);
    if (!latest) return;
    try { await fs.promises.writeFile(_canvasPath(ip), latest); } catch (_) {}
  }, CANVAS_WRITE_DEBOUNCE_MS);

  _touchMap(_canvasWriteTimers, ip, timer, MAX_DEVICE_STATE_ENTRIES);
}

/**
 * Write canvas to disk (best-effort — never throws).
 * Also updates the in-memory map.
 */
function _setCanvas(ip, canvas) {
  _touchMap(_drawCanvas, ip, canvas, MAX_DEVICE_STATE_ENTRIES);
  _scheduleCanvasPersist(ip, canvas);
}

/**
 * Get a writable copy of the canvas for ip.
 * Priority: in-memory → disk → fresh black buffer.
 * Warms up the in-memory cache from disk on first access after a restart.
 */
function _getCanvas(ip) {
  if (_drawCanvas.has(ip)) return Buffer.from(_drawCanvas.get(ip));
  try {
    const saved = fs.readFileSync(_canvasPath(ip));
    if (saved.length === CANVAS_BYTES) {
      _touchMap(_drawCanvas, ip, saved, MAX_DEVICE_STATE_ENTRIES); // warm in-memory cache
      return Buffer.from(saved);
    }
  } catch (_) {}
  return Buffer.alloc(CANVAS_BYTES, 0);
}

// ─── Animated sprites layer ─────────────────────────────────────────────────────
//
// Static draw operations (fillScreen, drawRect, drawImageAt, …) update the base
// canvas only.  drawLaMetricIcon with frame=0 on a multi-frame GIF registers an
// "animated sprite" instead of baking a single frame into the base canvas.
//
// _sendCanvas(ip) checks whether any sprites are registered:
//   • None  → sends the base canvas as a single static frame (existing behaviour).
//   • Some  → composites each sprite's frames cyclically on top of the base canvas,
//             builds a combined LCM-length animation, and sends it as one multi-frame
//             Draw/SendHttpGif sequence.  This allows N animated icons to run
//             simultaneously on the same display.
//
// Per-sprite data: { x, y, w, h, frames: Buffer[] (pre-resized RGBA w*h*4), delayMs }
const _animSprites = new Map(); // ip → Map<spriteKey, sprite>
const _animationModes = new Map(); // ip -> balanced | fast | slow | timing

function _getSprites(ip) {
  if (!_animSprites.has(ip)) _touchMap(_animSprites, ip, new Map(), MAX_DEVICE_STATE_ENTRIES);
  else _touchMap(_animSprites, ip, _animSprites.get(ip), MAX_DEVICE_STATE_ENTRIES);
  return _animSprites.get(ip);
}

function _clearSprites(ip) { _touchMap(_animSprites, ip, new Map(), MAX_DEVICE_STATE_ENTRIES); }

function _gcd(a, b) { return b === 0 ? a : _gcd(b, a % b); }
function _lcm(a, b) { return Math.round(a / _gcd(a, b)) * b; }
function _median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function _normalizeAnimationMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return ANIMATION_MODES.has(value) ? value : ANIMATION_MODE_DEFAULT;
}

function _getAnimationMode(ip) {
  return _animationModes.get(ip) || ANIMATION_MODE_DEFAULT;
}

function _getAnimationTiming(mode, sprites) {
  const delays = sprites.map((s) => s.delayMs);
  const minDelay = Math.min(...delays);
  const maxDelay = Math.max(...delays);

  if (mode === 'timing') {
    const speed = Math.max(20, minDelay);
    return {
      speed,
      framePeriods: sprites.map((s) => Math.max(1, Math.round(s.frames.length * s.delayMs / speed))),
      frameIndex: (i, sprite) => Math.floor((i * speed) / sprite.delayMs) % sprite.frames.length,
    };
  }

  const speed = mode === 'fast'
    ? minDelay
    : mode === 'slow'
      ? maxDelay
      : _median(delays);

  return {
    speed:        Math.max(20, speed),
    framePeriods: sprites.map((s) => s.frames.length),
    frameIndex:   (i, sprite) => i % sprite.frames.length,
  };
}

/**
 * Build the combined animation for ip: base canvas + all animated sprites.
 * Each sprite cycles through its own frames independently (LCM total frames, capped).
 * Returns { picData, picNum, picSpeed } ready for _scheduleDeviceSend.
 */
function _buildAnimation(ip) {
  const sprites = [..._getSprites(ip).values()];
  if (sprites.length === 0) {
    return { picData: _getCanvas(ip).toString('base64'), picNum: 1, picSpeed: 100 };
  }

  const mode = _getAnimationMode(ip);
  const { speed, framePeriods, frameIndex } = _getAnimationTiming(mode, sprites);
  const naturalFrameCount = framePeriods.reduce(_lcm, 1);
  const N = Math.min(naturalFrameCount, MAX_ANIM_FRAMES);

  const base = _getCanvas(ip);

  const canvases = [];
  for (let i = 0; i < N; i++) {
    const c = Buffer.from(base);
    for (const sprite of sprites) {
      const fi = frameIndex(i, sprite);
      const fr = sprite.frames[fi];
      for (let row = 0; row < sprite.h; row++) {
        for (let col = 0; col < sprite.w; col++) {
          const si = (row * sprite.w + col) * 4;
          const di = ((sprite.y + row) * 64 + (sprite.x + col)) * 3;
          const a  = fr[si + 3] / 255;
          const a1 = 1 - a;
          c[di]     = Math.round(fr[si]     * a + c[di]     * a1);
          c[di + 1] = Math.round(fr[si + 1] * a + c[di + 1] * a1);
          c[di + 2] = Math.round(fr[si + 2] * a + c[di + 2] * a1);
        }
      }
    }
    canvases.push(c);
  }
  return {
    picData:  canvases.map((c) => c.toString('base64')).join(''),
    picNum:   N,
    picSpeed: speed,
  };
}

/**
 * Send the current display: animated if sprites are registered, static otherwise.
 * No-op when the display is held — changes are flushed on releaseDisplay().
 */
function _sendCanvas(ip) {
  if (_held.has(ip)) return Promise.resolve();
  const { picData, picNum, picSpeed } = _buildAnimation(ip);
  return _scheduleDeviceSend(ip, picData, picNum, picSpeed);
}

function setAnimationMode(ip, mode) {
  const normalizedMode = _normalizeAnimationMode(mode);
  _touchMap(_animationModes, ip, normalizedMode, MAX_DEVICE_STATE_ENTRIES);
  if (_held.has(ip) || _getSprites(ip).size === 0) return Promise.resolve();
  return _sendCanvas(ip);
}

// ─── Hold / Release ────────────────────────────────────────────────────────────

const _held = new Set();
const _pendingTextClear = new Set();

/** Suspend all canvas sends for this IP. Draw ops still update local state. */
function holdDisplay(ip) {
  _held.add(ip);
}

/**
 * Flush all accumulated changes to the device in one send.
 * Text overlays are re-applied automatically after the canvas send.
 */
async function releaseDisplay(ip) {
  _held.delete(ip);
  if (_pendingTextClear.has(ip)) {
    _pendingTextClear.delete(ip);
    try { await post(ip, { Command: 'Draw/ClearHttpText' }); } catch (_) {}
  }
  return _sendCanvas(ip);
}

// ─── Text overlay registry ──────────────────────────────────────────────────────
//
// Draw/SendHttpText overlays are wiped whenever Channel/SetIndex is called, which
// happens on every Draw/SendHttpGif sequence in _runSend.  To keep text visible
// across GIF sends, every drawTextAt call registers its parameters here, and
// _reapplyTexts() re-sends all of them after each GIF completes.
//
// sendText (scrolling text) calls Draw/ClearHttpText, so it clears this registry.
//
// Map<ip, Map<textId, { text, x, y, color, font }>>
const _textRegistry = new Map();

function _getTextRegistry(ip) {
  if (!_textRegistry.has(ip)) _touchMap(_textRegistry, ip, new Map(), MAX_DEVICE_STATE_ENTRIES);
  else _touchMap(_textRegistry, ip, _textRegistry.get(ip), MAX_DEVICE_STATE_ENTRIES);
  return _textRegistry.get(ip);
}

async function _reapplyTexts(ip) {
  const reg = _textRegistry.get(ip);
  if (!reg || reg.size === 0) return;
  for (const [textId, t] of reg) {
    try {
      await post(ip, {
        Command:    'Draw/SendHttpText',
        TextId:     textId,
        x:          t.x,
        y:          t.y,
        dir:        0,
        font:       t.font,
        TextWidth:  Math.max(1, 64 - t.x),
        speed:      0,
        TextString: t.text,
        color:      t.color,
        align:      1,
      });
    } catch (_) {}
  }
}

// ───────────────────────────────────────────────────────────────────────────────

let _picId = 0;

/**
 * Display an image from a URL on the Pixoo64.
 *
 * GIF images with multiple frames are animated (frame=0, default) or shown
 * at a specific frame (frame=1…N, 1-based).  Animations are capped at
 * MAX_ANIM_FRAMES to keep payloads manageable.
 * Decoded frames are cached for 5 minutes.
 *
 * @param {string} ip
 * @param {string} url    http:// or https:// URL of a PNG or GIF image
 * @param {number} [frame=0]  0 = animate all frames; ≥1 = specific frame (1-based)
 * @returns {Promise<void>}
 */
async function sendImage(ip, url, frame = 0) {
  const frames = await _getImageFrames(url); // [{rgba: Buffer(64×64 RGBA), delayMs}]
  const base   = _getCanvas(ip);

  // Composite one RGBA frame onto the base canvas → RGB Buffer.
  // Transparent pixels in the image reveal whatever is on the canvas.
  function toRgb(rgba) {
    const rgb = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < 64 * 64; i++) {
      const a  = rgba[i * 4 + 3] / 255;
      const a1 = 1 - a;
      rgb[i * 3]     = Math.round(rgba[i * 4]     * a + base[i * 3]     * a1);
      rgb[i * 3 + 1] = Math.round(rgba[i * 4 + 1] * a + base[i * 3 + 1] * a1);
      rgb[i * 3 + 2] = Math.round(rgba[i * 4 + 2] * a + base[i * 3 + 2] * a1);
    }
    return rgb;
  }

  _clearSprites(ip);
  _getTextRegistry(ip).clear();

  let picData, picNum, picSpeed;
  if (frame <= 0 && frames.length > 1) {
    const rgbs = frames.map((f) => toRgb(f.rgba));
    picData  = rgbs.map((r) => r.toString('base64')).join('');
    picNum   = rgbs.length;
    picSpeed = frames[0].delayMs;
    _setCanvas(ip, rgbs[0]);
  } else {
    const idx = frame <= 0 ? 0 : Math.min(frame - 1, frames.length - 1);
    const rgb = toRgb(frames[idx].rgba);
    picData  = rgb.toString('base64');
    picNum   = 1;
    picSpeed = 100;
    _setCanvas(ip, rgb);
  }
  if (_held.has(ip)) return;
  return _scheduleDeviceSend(ip, picData, picNum, picSpeed);
}

/**
 * Fetch and decode all frames for a URL, caching for IMAGE_CACHE_TTL.
 * Returns [{rgba: Buffer(64×64 RGBA), delayMs}] — compositing onto the canvas
 * is deferred to call time so transparent pixels blend with whatever is displayed.
 */
async function _getImageFrames(url) {
  _pruneTtlCache(_frameCache, IMAGE_CACHE_TTL);
  const hit = _frameCache.get(url);
  if (hit && Date.now() - hit.ts < IMAGE_CACHE_TTL) {
    _touchMap(_frameCache, url, hit, MAX_FRAME_CACHE_ENTRIES);
    return hit.frames;
  }

  const allFrames = await ImageDecoder.decodeAllFramesFromUrl(url);
  const capped    = allFrames.slice(0, MAX_ANIM_FRAMES);

  const frames = capped.map(({ width, height, pixels, delayMs }) => ({
    rgba:    ImageDecoder.resizeRgba(pixels, width, height, 64, 64),
    delayMs: Math.max(20, delayMs),
  }));

  _touchMap(_frameCache, url, { frames, ts: Date.now() }, MAX_FRAME_CACHE_ENTRIES);
  return frames;
}

/**
 * Queue a device send, replacing any previous pending slot (last-wins).
 * @param {string} ip
 * @param {string} picData      Base64 pixel data (all frames concatenated)
 * @param {number} [picNum=1]   Number of animation frames
 * @param {number} [picSpeed=100]  Milliseconds per frame
 * @param {number} [timeoutMs]  HTTP timeout override (defaults to TIMEOUT_MS)
 */
function _scheduleDeviceSend(ip, picData, picNum = 1, picSpeed = 100, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!_sending.has(ip)) {
      _runSend(ip, picData, picNum, picSpeed, timeoutMs, resolve, reject);
    } else {
      const prev = _pending.get(ip);
      if (prev) {
        const err = new Error(`Superseded by a newer display update for ${ip}`);
        err.code = 'SEND_SUPERSEDED';
        prev.reject(err);
      }
      _pending.set(ip, { picData, picNum, picSpeed, timeoutMs, resolve, reject });
    }
  });
}

/** Drain the pending slot after any send completes. */
function _drainPending(ip) {
  const next = _pending.get(ip);
  if (!next) return;
  _pending.delete(ip);
  _runSend(ip, next.picData, next.picNum, next.picSpeed, next.timeoutMs, next.resolve, next.reject);
}

/**
 * Execute a Draw/SendHttpGif send (single or multi-frame), then drain the pending slot.
 *
 * The Pixoo64 API requires one POST per frame: each request carries PicOffset=i
 * (0-based frame index) with the same PicID and PicNum.  Sending all frames
 * concatenated in a single request causes the device to crash.
 */
function _runSend(ip, picData, picNum, picSpeed, timeoutMs, resolve, reject) {
  _picId = (_picId % 999) + 1;
  const picId    = _picId;
  const frameLen = Math.floor(picData.length / picNum); // base64 chars per frame

  // Sequence required by Pixoo64 firmware (confirmed broken without ResetHttpGifId
  // since firmware ~V90192, Aug-Sep 2024): without the reset the device treats any
  // previously seen PicID as cached and silently skips the new pixel data.
  // 1. Switch to Custom channel only if not already there (avoid mire flash).
  // 2. Reset the device-side GIF-ID cache so our PicID is always treated as new.
  // 3. Send frames one by one (PicOffset 0…N-1) — device starts animating once all received.
  const p = post(ip, { Command: 'Channel/GetIndex' })
    .then((res) => {
      if (res && res.SelectIndex === 3) return;
      return post(ip, { Command: 'Channel/SetIndex', SelectIndex: 3 });
    })
    .catch(() => {})
    .then(() => post(ip, { Command: 'Draw/ResetHttpGifId' }))
    .catch(() => {})
    .then(() => {
      let chain = Promise.resolve();
      for (let i = 0; i < picNum; i++) {
        const frameData = picData.slice(i * frameLen, (i + 1) * frameLen);
        chain = chain.then(() => post(ip, {
          Command:   'Draw/SendHttpGif',
          PicNum:    picNum,
          PicWidth:  64,
          PicOffset: i,
          PicID:     picId,
          PicSpeed:  picSpeed,
          PicData:   frameData,
        }, timeoutMs));
      }
      return chain;
    })
    .then((res) => {
      if (res && res.error_code !== undefined && res.error_code !== 0) {
        throw new Error(`SendHttpGif failed with error_code ${res.error_code}`);
      }
    })
    .then(() => _reapplyTexts(ip))
    .then(resolve, reject)
    .finally(() => { _sending.delete(ip); _drainPending(ip); });

  _sending.set(ip, p);
}

// ─── Text display ──────────────────────────────────────────────────────────────

/**
 * Display scrolling text on the Pixoo64.
 * Clears any previously displayed text first.
 *
 * @param {string} ip
 * @param {string} text    Message to display
 * @param {string} [color] CSS hex color, e.g. "#FF0000" (default white)
 * @param {number} [font]  Font index 0–7 (default 2)
 * @returns {Promise<void>}
 */
async function sendText(ip, text, color = '#FFFFFF', font = 2) {
  // Switch to Custom channel if needed (Draw/ commands require it on some firmware)
  try {
    const ch = await post(ip, { Command: 'Channel/GetIndex' });
    if (!ch || ch.SelectIndex !== 3) {
      await post(ip, { Command: 'Channel/SetIndex', SelectIndex: 3 });
    }
  } catch (_) {}

  // Clear previous text items (best-effort — some firmware ignores this command).
  // Also wipe the registry so drawTextAt overlays aren't re-applied after future GIF sends.
  _getTextRegistry(ip).clear();
  try { await post(ip, { Command: 'Draw/ClearHttpText' }); } catch (_) {}

  const res = await post(ip, {
    Command:    'Draw/SendHttpText',
    TextId:     1,
    x:          0,
    y:          0,
    dir:        0,       // 0 = scroll left
    font:       Math.max(0, Math.min(7, Math.round(font))),
    TextWidth:  64,
    speed:      100,
    TextString: String(text),
    color:      color,
    align:      1,       // 1 = left
  });

  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`SendHttpText failed with error_code ${res.error_code}`);
  }
}

// ─── Clear text overlays ───────────────────────────────────────────────────────

/**
 * Clear all DrawHttpText overlays and the text registry so they won't
 * be re-applied after future GIF sends.
 */
async function clearTextOverlays(ip) {
  _getTextRegistry(ip).clear();
  if (_held.has(ip)) {
    _pendingTextClear.add(ip);
    return;
  }
  try { await post(ip, { Command: 'Draw/ClearHttpText' }); } catch (_) {}
}

// ─── Channel switching ─────────────────────────────────────────────────────────

/**
 * Read the currently selected Pixoo64 channel.
 *
 * @param {string} ip
 * @returns {Promise<number>} 0=Clock 1=Cloud 2=Visualizer 3=Custom 4=Black
 */
async function getChannel(ip) {
  const res = await post(ip, { Command: 'Channel/GetIndex' });
  const index = Number(res.SelectIndex);
  if (!Number.isFinite(index)) {
    throw new Error(`GetIndex returned no SelectIndex: ${JSON.stringify(res).slice(0, 160)}`);
  }
  return index;
}

/**
 * Switch the Pixoo64 to a built-in channel.
 *
 * @param {string} ip
 * @param {number} index  0=Clock  1=Cloud  2=Visualizer  3=Custom  4=Black
 * @returns {Promise<void>}
 */
async function setChannel(ip, index) {
  const res = await post(ip, {
    Command:     'Channel/SetIndex',
    SelectIndex: index,
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`SetIndex failed with error_code ${res.error_code}`);
  }
}

// ─── Buzzer ────────────────────────────────────────────────────────────────────

/**
 * Play the Pixoo64's built-in buzzer.
 *
 * @param {string} ip
 * @param {number} durationMs  Total buzzer duration in milliseconds (500–30 000)
 * @returns {Promise<void>}
 */
async function playBuzzer(ip, durationMs) {
  const total = Math.max(500, Math.min(30000, Math.round(durationMs)));
  const res = await post(ip, {
    Command:          'Device/PlayBuzzer',
    ActiveTimeInCycle: 500,
    OffTimeInCycle:    500,
    PlayTotalTime:     total,
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`PlayBuzzer failed with error_code ${res.error_code}`);
  }
}

// ─── Scoreboard ────────────────────────────────────────────────────────────────

/**
 * Display the built-in scoreboard with red and blue scores.
 *
 * @param {string} ip
 * @param {number} redScore   0–999
 * @param {number} blueScore  0–999
 * @returns {Promise<void>}
 */
async function showScoreboard(ip, redScore, blueScore) {
  const res = await post(ip, {
    Command:   'Tools/SetScoreBoard',
    RedScore:  Math.max(0, Math.min(999, Math.round(redScore))),
    BlueScore: Math.max(0, Math.min(999, Math.round(blueScore))),
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`SetScoreBoard failed with error_code ${res.error_code}`);
  }
}

// ─── Timer ─────────────────────────────────────────────────────────────────────

/**
 * Start the built-in countdown timer.
 *
 * @param {string} ip
 * @param {number} minutes  0–99
 * @param {number} seconds  0–59
 * @returns {Promise<void>}
 */
async function startTimer(ip, minutes, seconds) {
  const res = await post(ip, {
    Command: 'Tools/SetTimer',
    Minute:  Math.max(0, Math.min(99, Math.round(minutes))),
    Second:  Math.max(0, Math.min(59, Math.round(seconds))),
    Status:  1,
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`SetTimer failed with error_code ${res.error_code}`);
  }
}

/**
 * Stop the built-in countdown timer.
 *
 * @param {string} ip
 * @returns {Promise<void>}
 */
async function stopTimer(ip) {
  const res = await post(ip, {
    Command: 'Tools/SetTimer',
    Minute:  0,
    Second:  0,
    Status:  0,
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`SetTimer failed with error_code ${res.error_code}`);
  }
}

// ─── Drawing primitives ────────────────────────────────────────────────────────

/**
 * Convert a CSS hex color string to [r, g, b].
 * @param {string} hex  e.g. "#FF0000" or "FF0000"
 * @returns {number[]}
 */
function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/**
 * Fill the entire 64×64 screen with a solid color.
 *
 * @param {string} ip
 * @param {string} color  CSS hex color, e.g. "#FF0000"
 * @returns {Promise<void>}
 */
async function fillScreen(ip, color) {
  const [r, g, b] = _hexToRgb(color);
  const canvas    = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < 64 * 64; i++) {
    canvas[i * 3]     = r;
    canvas[i * 3 + 1] = g;
    canvas[i * 3 + 2] = b;
  }
  _setCanvas(ip, canvas);
  _clearSprites(ip);
  if (_held.has(ip)) return;
  return _scheduleDeviceSend(ip, canvas.toString('base64'));
}

/**
 * Draw a filled rectangle on the retained canvas with optional transparency.
 *
 * @param {string} ip
 * @param {number} x        Top-left column (0–63)
 * @param {number} y        Top-left row (0–63)
 * @param {number} w        Width  (1–64)
 * @param {number} h        Height (1–64)
 * @param {string} color    CSS hex color, e.g. "#00FF00"
 * @param {number} [opacity=100]  Opacity 0 (fully transparent) – 100 (fully opaque)
 * @returns {Promise<void>}
 */
async function drawRect(ip, x, y, w, h, color, opacity = 100) {
  const [r, g, b] = _hexToRgb(color);
  const alpha = Math.max(0, Math.min(100, Math.round(opacity))) / 100;
  // Composite onto the retained canvas (or restore from disk / start black)
  const canvas = _getCanvas(ip);
  const x1 = Math.max(0, Math.min(63, Math.round(x)));
  const y1 = Math.max(0, Math.min(63, Math.round(y)));
  const x2 = Math.min(64, x1 + Math.max(1, Math.round(w)));
  const y2 = Math.min(64, y1 + Math.max(1, Math.round(h)));
  for (let py = y1; py < y2; py++) {
    for (let px = x1; px < x2; px++) {
      const idx        = (py * 64 + px) * 3;
      canvas[idx]      = Math.round(r * alpha + canvas[idx]     * (1 - alpha));
      canvas[idx + 1]  = Math.round(g * alpha + canvas[idx + 1] * (1 - alpha));
      canvas[idx + 2]  = Math.round(b * alpha + canvas[idx + 2] * (1 - alpha));
    }
  }
  _setCanvas(ip, canvas);
  return _sendCanvas(ip);
}

/**
 * Draw text at a position using the built-in 3×5 pixel font (rendered onto
 * the retained canvas).  Text is automatically uppercased and accents stripped.
 *
 * @param {string} ip
 * @param {string} text    Text to render
 * @param {number} x       Left edge column (0–63)
 * @param {number} y       Top edge row    (0–63)
 * @param {string} color   CSS hex color, e.g. "#FFFF00"
 * @returns {Promise<void>}
 */
async function drawPixelText(ip, text, x, y, color, fontName = 'tiny') {
  const canvas = _getCanvas(ip);
  PixelFont.renderText(text, color, canvas, x, y, fontName);
  _setCanvas(ip, canvas);
  return _sendCanvas(ip);
}

/**
 * Draw static text at a specific position using the Pixoo text overlay API.
 * Each textId (2–20) is an independent slot — multiple texts can coexist on screen.
 * TextId 1 is reserved for the scrolling text (sendText); start from 2 here.
 *
 * @param {string} ip
 * @param {string} text       Text to display
 * @param {number} x          Column (0–63)
 * @param {number} y          Row (0–63)
 * @param {string} color      CSS hex color, e.g. "#FFFF00"
 * @param {number} [font=2]   Font index 0–7
 * @param {number} [textId=2] Unique text slot (2–20); same ID = update in-place
 * @returns {Promise<void>}
 */
async function drawTextAt(ip, text, x, y, color, font = 2, textId = 2) {
  const px   = Math.max(0, Math.min(63, Math.round(x)));
  const py   = Math.max(0, Math.min(63, Math.round(y)));
  const tid  = Math.max(2, Math.min(20, Math.round(textId)));
  const fnt  = Math.max(0, Math.min(7, Math.round(font)));
  // Register so the text survives subsequent GIF sends (Channel/SetIndex resets overlays).
  _getTextRegistry(ip).set(tid, { text: String(text), x: px, y: py, color, font: fnt });
  if (_held.has(ip)) return;  // will be sent on releaseDisplay via _reapplyTexts
  const res = await post(ip, {
    Command:    'Draw/SendHttpText',
    TextId:     tid,
    x:          px,
    y:          py,
    dir:        0,
    font:       fnt,
    TextWidth:  Math.max(1, 64 - px),
    speed:      0,
    TextString: String(text),
    color:      color,
    align:      1,
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`SendHttpText failed with error_code ${res.error_code}`);
  }
}

// Raw decoded-image cache (before resize): url → { data: {width,height,pixels}, ts }
const _rawImageCache = new Map();

/** Return first-frame RGBA pixels for `url`, fetching and decoding on first access. */
async function _getOrDecodeImageRaw(url) {
  _pruneTtlCache(_rawImageCache, IMAGE_CACHE_TTL);
  const hit = _rawImageCache.get(url);
  if (hit && Date.now() - hit.ts < IMAGE_CACHE_TTL) {
    _touchMap(_rawImageCache, url, hit, MAX_RAW_IMAGE_CACHE_ENTRIES);
    return hit.data;
  }
  // decodeAllFramesFromUrl handles GIF transparency (transparent color index) and PNG alpha.
  const frames = await ImageDecoder.decodeAllFramesFromUrl(url);
  const { width, height, pixels } = frames[0]; // RGBA
  const data = { width, height, pixels };
  _touchMap(_rawImageCache, url, { data, ts: Date.now() }, MAX_RAW_IMAGE_CACHE_ENTRIES);
  return data;
}

/**
 * Draw an image from a URL at a given position and size on the 64×64 canvas.
 * The image is decoded, resized to w×h, and composited onto a black canvas.
 *
 * @param {string} ip
 * @param {string} url  http:// or https:// URL of a PNG or GIF
 * @param {number} x    Top-left column (0–63)
 * @param {number} y    Top-left row (0–63)
 * @param {number} w    Target width  (1–64)
 * @param {number} h    Target height (1–64)
 * @returns {Promise<void>}
 */
async function drawImageAt(ip, url, x, y, w, h) {
  const px = Math.max(0, Math.min(63, Math.round(x)));
  const py = Math.max(0, Math.min(63, Math.round(y)));
  const pw = Math.max(1, Math.min(64 - px, Math.round(w)));
  const ph = Math.max(1, Math.min(64 - py, Math.round(h)));

  const { width: srcW, height: srcH, pixels: srcPixels } = await _getOrDecodeImageRaw(url); // RGBA
  const resized = ImageDecoder.resizeRgba(srcPixels, srcW, srcH, pw, ph);

  // Alpha-composite onto the retained canvas
  const canvas = _getCanvas(ip);
  for (let row = 0; row < ph; row++) {
    for (let col = 0; col < pw; col++) {
      const si = (row * pw + col) * 4;
      const di = ((py + row) * 64 + (px + col)) * 3;
      const a  = resized[si + 3] / 255;
      const a1 = 1 - a;
      canvas[di]     = Math.round(resized[si]     * a + canvas[di]     * a1);
      canvas[di + 1] = Math.round(resized[si + 1] * a + canvas[di + 1] * a1);
      canvas[di + 2] = Math.round(resized[si + 2] * a + canvas[di + 2] * a1);
    }
  }

  _setCanvas(ip, canvas);
  return _sendCanvas(ip);
}

// ─── Local (bundled) image display ─────────────────────────────────────────────

// Cache for bundled images: filename → { width, height, pixels } raw decoded data.
// Bundled files never change at runtime, so no TTL is needed.
const _localImageCache = new Map();

/**
 * Display a PNG or GIF from the app's assets/display/ folder on the Pixoo64.
 * Always rendered at 8×8 pixels; alpha channel is composited onto the retained canvas.
 * Raw RGBA pixels are cached in memory after the first file read.
 *
 * @param {string} ip
 * @param {string} filename  Bare filename including extension, e.g. "alert.png"
 * @param {number} [x=0]    Top-left column (0–63)
 * @param {number} [y=0]    Top-left row (0–63)
 * @returns {Promise<void>}
 */
async function sendLocalImage(ip, filename, x = 0, y = 0) {
  const px = Math.max(0, Math.min(63, Math.round(x)));
  const py = Math.max(0, Math.min(63, Math.round(y)));
  const pw = Math.min(8, 64 - px);
  const ph = Math.min(8, 64 - py);

  let rawData = _localImageCache.get(filename);
  if (!rawData) {
    const filePath = path.join(LOCAL_IMAGES_DIR, filename);
    const buffer   = await fs.promises.readFile(filePath);
    rawData        = ImageDecoder.decodeRgbaFromBuffer(buffer);
    _touchMap(_localImageCache, filename, rawData, MAX_LOCAL_IMAGE_CACHE_ENTRIES);
  } else {
    _touchMap(_localImageCache, filename, rawData, MAX_LOCAL_IMAGE_CACHE_ENTRIES);
  }

  const { width: srcW, height: srcH, pixels: srcPixels } = rawData;
  const resized = ImageDecoder.resizeRgba(srcPixels, srcW, srcH, pw, ph);

  // Alpha-composite onto the retained canvas
  const canvas = _getCanvas(ip);
  for (let row = 0; row < ph; row++) {
    for (let col = 0; col < pw; col++) {
      const si  = (row * pw + col) * 4;
      const di  = ((py + row) * 64 + (px + col)) * 3;
      const a   = resized[si + 3] / 255;
      const a1  = 1 - a;
      canvas[di]     = Math.round(resized[si]     * a + canvas[di]     * a1);
      canvas[di + 1] = Math.round(resized[si + 1] * a + canvas[di + 1] * a1);
      canvas[di + 2] = Math.round(resized[si + 2] * a + canvas[di + 2] * a1);
    }
  }
  _setCanvas(ip, canvas);
  return _sendCanvas(ip);
}

// ─── LaMetric icon display ─────────────────────────────────────────────────────

// LaMetric icon cache: iconId → Array<{width, height, left, top, pixels: RGBA, delayMs}>
// Icons are cached permanently — content is stable by ID for an app session.
const _laMetricCache = new Map();

/**
 * Fetch a LaMetric icon by ID and draw it at 8×8 px on the retained canvas.
 * URL: https://developer.lametric.com/content/apps/icon_thumbs/<id>
 * Supports PNG (alpha preserved) and animated GIF.
 * Results are cached in memory for the lifetime of the app session.
 *
 * frame=0 on a multi-frame GIF: registers an animated sprite so that multiple
 * animated icons can run simultaneously on the same display.  Each sprite is
 * layered on top of the static base canvas; _sendCanvas() composites them all.
 *
 * @param {string} ip
 * @param {string|number} id      LaMetric icon ID (e.g. 1531)
 * @param {number} [x=0]         Top-left column (0–63)
 * @param {number} [y=0]         Top-left row (0–63)
 * @param {number} [frame=0]     0 = animate all frames; ≥1 = specific frame (1-based)
 * @returns {Promise<void>}
 */
async function drawLaMetricIcon(ip, id, x = 0, y = 0, frame = 0, zoom = 1) {
  const px = Math.max(0, Math.min(63, Math.round(x)));
  const py = Math.max(0, Math.min(63, Math.round(y)));
  const sz = Math.max(1, Math.min(8, Math.round(zoom))) * 8;
  const pw = Math.min(sz, 64 - px);
  const ph = Math.min(sz, 64 - py);

  const iconId = String(id).replace(/[^0-9]/g, '');
  if (!iconId) throw new Error('Invalid LaMetric icon ID');

  let allFrames = _laMetricCache.get(iconId);
  if (!allFrames) {
    const url = `https://developer.lametric.com/content/apps/icon_thumbs/${iconId}`;
    allFrames = await ImageDecoder.decodeAllFramesFromUrl(url);
    _touchMap(_laMetricCache, iconId, allFrames, MAX_LAMETRIC_CACHE_ENTRIES);
  } else {
    _touchMap(_laMetricCache, iconId, allFrames, MAX_LAMETRIC_CACHE_ENTRIES);
  }

  const spriteKey = `${px}_${py}`;

  if (frame <= 0 && allFrames.length > 1) {
    // Animated: register as a sprite so it can coexist with other animated icons.
    // Pre-resize each frame to the target dimensions once (avoid per-render resizing).
    const capped = allFrames.slice(0, MAX_ANIM_FRAMES);
    const resizedFrames = capped.map(({ width: srcW, height: srcH, pixels }) =>
      ImageDecoder.resizeRgba(pixels, srcW, srcH, pw, ph)
    );
    _getSprites(ip).set(spriteKey, {
      x: px, y: py, w: pw, h: ph,
      frames:  resizedFrames,
      delayMs: Math.max(20, allFrames[0].delayMs),
    });
    return _sendCanvas(ip);
  }

  // Static frame: composite onto the base canvas, remove any sprite at this slot.
  const frameIdx = frame <= 0 ? 0 : Math.min(frame - 1, allFrames.length - 1);
  const { width: srcW, height: srcH, pixels: srcPixels } = allFrames[frameIdx];
  const resized = ImageDecoder.resizeRgba(srcPixels, srcW, srcH, pw, ph);
  const canvas  = _getCanvas(ip);
  for (let row = 0; row < ph; row++) {
    for (let col = 0; col < pw; col++) {
      const si = (row * pw + col) * 4;
      const di = ((py + row) * 64 + (px + col)) * 3;
      const a  = resized[si + 3] / 255;
      const a1 = 1 - a;
      canvas[di]     = Math.round(resized[si]     * a + canvas[di]     * a1);
      canvas[di + 1] = Math.round(resized[si + 1] * a + canvas[di + 1] * a1);
      canvas[di + 2] = Math.round(resized[si + 2] * a + canvas[di + 2] * a1);
    }
  }
  _setCanvas(ip, canvas);
  _getSprites(ip).delete(spriteKey);
  return _sendCanvas(ip);
}

// ─── Screenshot (save / restore canvas state) ──────────────────────────────────

// ── Minimal PNG encoder (pure Node.js, uses built-in zlib) ───────────────────

// CRC32 lookup table — computed once at load time.
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function _crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = _crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len       = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const crcVal    = Buffer.allocUnsafe(4); crcVal.writeUInt32BE(_crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

/**
 * Encode a 64×64×3 RGB Buffer into a valid PNG file buffer.
 * Uses filter type 0 (None) per scanline and zlib level-6 compression.
 */
function _canvasToPng(canvas) {
  const W = 64, H = 64;
  const magic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR — 13 bytes: width(4) height(4) bitDepth(1) colorType(1=RGB=2) comp(1) filter(1) interlace(1)
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(W, 0);
  ihdrData.writeUInt32BE(H, 4);
  ihdrData[8] = 8; ihdrData[9] = 2; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

  // IDAT — one filter byte (0 = None) followed by W×3 RGB bytes per scanline
  const raw = Buffer.allocUnsafe(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: None
    canvas.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }

  return Buffer.concat([
    magic,
    _pngChunk('IHDR', ihdrData),
    _pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    _pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Path of a screenshot PNG for a given device IP and slot (1–5). */
const _shotPath = (ip, slot) => {
  const s = String(slot).replace(/[^a-zA-Z0-9_-]/g, '') || '1';
  return path.join('/userdata', `px64_shot_${ip.replace(/\./g, '-')}_${s}.png`);
};

/**
 * Public path helper — used by app.js to call img.setPath() after takeScreenshot().
 * @param {string} ip
 * @param {string|number} slot
 * @returns {string}
 */
function shotPath(ip, slot) { return _shotPath(ip, slot); }

/**
 * Render the current visual state as a single RGB buffer: base canvas with all
 * animated sprites composited at their first frame.
 * Note: Draw/SendHttpText overlays are rendered by the device firmware on top of
 * the GIF layer and are never part of the canvas buffer — they cannot be captured.
 */
function _compositeFrame0(ip) {
  const sprites = [..._getSprites(ip).values()];
  const canvas  = _getCanvas(ip); // writable copy of base
  for (const sprite of sprites) {
    const fr = sprite.frames[0];
    for (let row = 0; row < sprite.h; row++) {
      for (let col = 0; col < sprite.w; col++) {
        const si = (row * sprite.w + col) * 4;
        const di = ((sprite.y + row) * 64 + (sprite.x + col)) * 3;
        const a  = fr[si + 3] / 255;
        const a1 = 1 - a;
        canvas[di]     = Math.round(fr[si]     * a + canvas[di]     * a1);
        canvas[di + 1] = Math.round(fr[si + 1] * a + canvas[di + 1] * a1);
        canvas[di + 2] = Math.round(fr[si + 2] * a + canvas[di + 2] * a1);
      }
    }
  }
  return canvas;
}

/**
 * Save the current canvas state as a PNG screenshot in the given slot.
 * Animated sprites are captured at their first frame.
 * Draw/SendHttpText overlays are not captured (firmware-side rendering).
 *
 * @param {string} ip
 * @param {string|number} slot  Identifier for the save slot (e.g. "1"–"5")
 * @returns {Promise<void>}
 */
async function takeScreenshot(ip, slot) {
  const canvas = _compositeFrame0(ip);
  const png    = _canvasToPng(canvas);
  await fs.promises.writeFile(_shotPath(ip, slot), png);
}

/**
 * Display a previously saved screenshot from the given slot.
 * The PNG is decoded, set as the new retained canvas, and sent to the device.
 * Throws if no screenshot has been saved in that slot.
 *
 * @param {string} ip
 * @param {string|number} slot
 * @returns {Promise<void>}
 */
async function displayScreenshot(ip, slot) {
  const filePath = _shotPath(ip, slot);
  let pngBuffer;
  try {
    pngBuffer = await fs.promises.readFile(filePath);
  } catch (_) {
    throw new Error(`No screenshot saved in slot ${slot} for device ${ip}`);
  }
  const { width: srcW, height: srcH, pixels } = ImageDecoder.decodeFromBuffer(pngBuffer);
  const canvas = Buffer.from(ImageDecoder.resizeRgb(pixels, srcW, srcH, 64, 64));
  _setCanvas(ip, canvas);
  if (_held.has(ip)) return;
  return _scheduleDeviceSend(ip, canvas.toString('base64'));
}

// ─── Time sync ─────────────────────────────────────────────────────────────────

/**
 * Push the current UTC time to the device so its built-in clock stays accurate.
 *
 * @param {string} ip
 * @returns {Promise<void>}
 */
async function syncTime(ip) {
  const utc = Math.floor(Date.now() / 1000);
  const res = await post(ip, {
    Command: 'Device/SetUTC',
    Utc:     utc,
  });
  if (res.error_code !== undefined && res.error_code !== 0) {
    throw new Error(`SetUTC failed with error_code ${res.error_code}`);
  }
}

/**
 * Clear the screen completely: wipes the canvas black, removes all animated
 * sprites, and clears all firmware text overlays.
 * Respects Hold: when held, all changes are flushed on releaseDisplay().
 *
 * @param {string} ip
 * @returns {Promise<void>}
 */
async function cleanDisplay(ip) {
  _clearSprites(ip);
  _getTextRegistry(ip).clear();
  const black = Buffer.alloc(CANVAS_BYTES, 0);
  _setCanvas(ip, black);
  if (_held.has(ip)) {
    _pendingTextClear.add(ip);
    return;
  }
  try { await post(ip, { Command: 'Draw/ClearHttpText' }); } catch (_) {}
  return _scheduleDeviceSend(ip, black.toString('base64'));
}

/**
 * Clear animated sprites, text overlays, and reset the base canvas to black.
 * Does not send anything to the device — the next draw call triggers the send.
 */
function resetDisplay(ip) {
  _clearSprites(ip);
  _getTextRegistry(ip).clear();
  _setCanvas(ip, Buffer.alloc(CANVAS_BYTES, 0));
}

/**
 * Drop all in-memory state associated with a device IP.
 * Keeps on-disk canvas/screenshot files untouched.
 *
 * @param {string} ip
 */
function forgetDevice(ip) {
  ip = normalizeIpInput(ip);
  _sending.delete(ip);
  _pending.delete(ip);
  _drawCanvas.delete(ip);
  _animSprites.delete(ip);
  _animationModes.delete(ip);
  _textRegistry.delete(ip);
  _held.delete(ip);
  _pendingTextClear.delete(ip);
  _endpointCache.delete(ip);
  const timer = _canvasWriteTimers.get(ip);
  if (timer) clearTimeout(timer);
  _canvasWriteTimers.delete(ip);
  _canvasWriteLatest.delete(ip);
}

module.exports = {
  getDeviceInfo, getScreenState, setOnOff, setBrightness,
  discoverDevices, discoverCloudDevices, findCloudDeviceByIp, rediscoverDevice,
  resolveEndpoint, endpointSettings, normalizeIpInput, subnetFromIp,
  holdDisplay, releaseDisplay,
  sendImage, sendLocalImage, sendText, clearTextOverlays, getChannel, setChannel, playBuzzer, syncTime,
  showScoreboard, startTimer, stopTimer, setAnimationMode,
  fillScreen, drawRect, drawTextAt, drawPixelText, drawImageAt, drawLaMetricIcon,
  cleanDisplay, resetDisplay, forgetDevice,
  takeScreenshot, displayScreenshot, shotPath,
};
