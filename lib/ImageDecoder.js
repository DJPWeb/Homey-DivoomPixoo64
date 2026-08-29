'use strict';

/**
 * ImageDecoder
 *
 * Pure Node.js image decoder for the Pixoo64 — zero external dependencies.
 * Supports PNG (8-bit RGB/RGBA) and GIF (first frame).
 * Fetches an image from a URL, decodes to raw RGB, resizes to 64×64,
 * and returns the data as a base64 string ready for Draw/SendHttpGif.
 *
 * Uses only Node built-ins: http, https, zlib.
 */

const http  = require('http');
const https = require('https');
const zlib  = require('zlib');

const PIXOO_SIZE = 64;
const MAX_IMAGE_DIMENSION = 1200;
const MAX_IMAGE_PIXELS    = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION;
const MAX_FETCH_BYTES     = 12 * 1024 * 1024; // 12 MB
const FETCH_TIMEOUT_MS    = 10000;

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch an image from a URL, decode it and resize to 64×64.
 * Returns the raw RGB pixel data as a base64 string (12 288 bytes).
 * Supports PNG (RGB/RGBA 8-bit) and GIF (indexed color, first frame).
 *
 * @param {string} url  http:// or https:// URL of a PNG or GIF image
 * @returns {Promise<string>}  base64-encoded 64×64 RGB pixel data
 */
async function toPixooImageData(url) {
  const { buffer, finalUrl }    = await _fetchBuffer(url);
  const { width, height, pixels } = await _decodeWithJpegFallback(buffer, finalUrl);
  const rgb64                   = _resizeTo64(pixels, width, height);
  return rgb64.toString('base64');
}

/**
 * Fetch an image from a URL and decode it to raw RGB pixels without resizing.
 * Useful when you need to composite or resize to custom dimensions.
 *
 * @param {string} url
 * @returns {Promise<{width: number, height: number, pixels: Buffer}>}
 */
async function decodeFromUrl(url) {
  const { buffer, finalUrl } = await _fetchBuffer(url);
  return _decodeWithJpegFallback(buffer, finalUrl);
}

/**
 * Bilinear resize of raw RGB pixel data to arbitrary dimensions.
 * Produces smoother results than nearest-neighbour when downscaling
 * large images to the Pixoo's 64×64 canvas.
 *
 * @param {Buffer} pixels  Source pixels (RGB, srcW*srcH*3 bytes)
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Buffer}  dstW*dstH*3 bytes
 */
function resizeRgb(pixels, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return pixels;

  const dst    = Buffer.alloc(dstW * dstH * 3);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const sy  = y * scaleY;
    const y0  = Math.floor(sy);
    const y1  = Math.min(y0 + 1, srcH - 1);
    const fy  = sy - y0;
    const fy1 = 1 - fy;

    for (let x = 0; x < dstW; x++) {
      const sx  = x * scaleX;
      const x0  = Math.floor(sx);
      const x1  = Math.min(x0 + 1, srcW - 1);
      const fx  = sx - x0;
      const fx1 = 1 - fx;

      const s00 = (y0 * srcW + x0) * 3;
      const s10 = (y0 * srcW + x1) * 3;
      const s01 = (y1 * srcW + x0) * 3;
      const s11 = (y1 * srcW + x1) * 3;
      const di  = (y  * dstW  + x) * 3;

      dst[di]     = Math.round(pixels[s00]     * fx1 * fy1 + pixels[s10]     * fx * fy1 + pixels[s01]     * fx1 * fy + pixels[s11]     * fx * fy);
      dst[di + 1] = Math.round(pixels[s00 + 1] * fx1 * fy1 + pixels[s10 + 1] * fx * fy1 + pixels[s01 + 1] * fx1 * fy + pixels[s11 + 1] * fx * fy);
      dst[di + 2] = Math.round(pixels[s00 + 2] * fx1 * fy1 + pixels[s10 + 2] * fx * fy1 + pixels[s01 + 2] * fx1 * fy + pixels[s11 + 2] * fx * fy);
    }
  }

  return dst;
}

/**
 * Decode a Buffer (already fetched) and resize to 64×64.
 * Synchronous — no network I/O.
 *
 * @param {Buffer} buffer  Raw image bytes (PNG or GIF)
 * @returns {string}  base64-encoded 64×64 RGB pixel data
 */
function toPixooImageDataFromBuffer(buffer) {
  const { width, height, pixels } = _decode(buffer);
  return _resizeTo64(pixels, width, height).toString('base64');
}

/**
 * Decode a PNG or GIF buffer to raw RGB pixels without resizing.
 * Returns the same shape as decodeFromUrl: { width, height, pixels }.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
function decodeFromBuffer(buffer) {
  return _decode(buffer);
}

/**
 * Fetch an image from a URL and decode it to raw RGBA pixels without resizing.
 * PNG: alpha preserved. GIF: fully opaque (first frame only).
 *
 * @param {string} url
 * @returns {Promise<{width: number, height: number, pixels: Buffer}>}
 */
async function decodeRgbaFromUrl(url) {
  const { buffer } = await _fetchBuffer(url);
  return decodeRgbaFromBuffer(buffer);
}

/**
 * Decode a PNG or GIF buffer to raw RGBA pixels (4 bytes per pixel).
 * For PNG: preserves the alpha channel as-is (no pre-multiplication).
 * For GIF: alpha is set to 255 (fully opaque) for every pixel.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
function decodeRgbaFromBuffer(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return _decodePngRgba(buffer);
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    const { width, height, pixels } = _decodeGif(buffer);
    const rgba = Buffer.alloc(width * height * 4, 0xFF);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4]     = pixels[i * 3];
      rgba[i * 4 + 1] = pixels[i * 3 + 1];
      rgba[i * 4 + 2] = pixels[i * 3 + 2];
      // alpha byte already 0xFF from Buffer.alloc fill
    }
    return { width, height, pixels: rgba };
  }
  throw new Error('Unsupported image format — provide a PNG or GIF file');
}

/**
 * Nearest-neighbour resize of raw RGBA pixel data to arbitrary dimensions.
 * Nearest-neighbour is preferred over bilinear for pixel-art sprites because
 * it preserves hard edges and avoids blurring the alpha channel.
 *
 * @param {Buffer} pixels  Source pixels (RGBA, srcW*srcH*4 bytes)
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Buffer}  dstW*dstH*4 bytes
 */
function resizeRgba(pixels, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return pixels;

  const dst    = Buffer.alloc(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(Math.floor(x * scaleX), srcW - 1);
      const sy = Math.min(Math.floor(y * scaleY), srcH - 1);
      const si = (sy * srcW + sx) * 4;
      const di = (y  * dstW  + x) * 4;
      dst[di]     = pixels[si];
      dst[di + 1] = pixels[si + 1];
      dst[di + 2] = pixels[si + 2];
      dst[di + 3] = pixels[si + 3];
    }
  }

  return dst;
}

/**
 * Decode all frames of a PNG or GIF buffer.
 * PNG is treated as a single frame (RGBA, delayMs=100).
 * GIF returns all frames with their RGBA pixels and frame delay.
 * Each frame: { width, height, left, top, pixels: Buffer(RGBA), delayMs }.
 *
 * @param {Buffer} buffer
 * @returns {Array<{width: number, height: number, left: number, top: number, pixels: Buffer, delayMs: number}>}
 */
function decodeAllFrames(buffer) {
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return _decodeGifFrames(buffer);
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    const { width, height, pixels } = _decodePngRgba(buffer);
    return [{ width, height, left: 0, top: 0, pixels, delayMs: 100 }];
  }
  throw new Error('Unsupported image format — provide a PNG or GIF file');
}

/**
 * Fetch an image from a URL and decode all frames.
 * If the server returns a JPEG (e.g. Homey image proxy redirecting to Apple CDN),
 * automatically retries with .png substituted in the final URL — same strategy
 * as _decodeWithJpegFallback used by decodeFromUrl.
 * @param {string} url
 * @returns {Promise<Array<{width: number, height: number, left: number, top: number, pixels: Buffer, delayMs: number}>>}
 */
async function decodeAllFramesFromUrl(url) {
  const { buffer, finalUrl } = await _fetchBuffer(url);
  if (_isJpeg(buffer)) {
    const pngUrl = finalUrl.replace(/\.jpe?g(?=[?#]|$)/i, '.png');
    if (pngUrl !== finalUrl) {
      const { buffer: pngBuffer } = await _fetchBuffer(pngUrl);
      return decodeAllFrames(pngBuffer);
    }
  }
  return decodeAllFrames(buffer);
}

module.exports = { toPixooImageData, toPixooImageDataFromBuffer, decodeFromUrl, decodeFromBuffer, decodeRgbaFromUrl, decodeRgbaFromBuffer, resizeRgb, resizeRgba, decodeAllFrames, decodeAllFramesFromUrl };

// ─── Format dispatch ───────────────────────────────────────────────────────────

function _decode(buffer) {
  // PNG magic: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return _decodePng(buffer);
  }
  // GIF magic: GIF8
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return _decodeGif(buffer);
  }
  throw new Error('Unsupported image format — provide a PNG or GIF file');
}

function _assertImageBounds(width, height, label = 'image') {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid ${label} dimensions`);
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(
      `${label} too large (${width}x${height}). Max allowed is ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}`,
    );
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`${label} has too many pixels (${width * height}). Max allowed is ${MAX_IMAGE_PIXELS}`);
  }
}

// ─── HTTP fetch ────────────────────────────────────────────────────────────────

/**
 * Fetch a URL and return the response body as a Buffer.
 * Follows up to 3 redirects.
 *
 * @param {string} url
 * @param {number} [redirectsLeft]
 * @returns {Promise<Buffer>}
 */
/**
 * Returns true if the buffer starts with JPEG magic bytes (FF D8 FF).
 */
function _isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
}

/**
 * Decode a buffer; if it is JPEG and the finalUrl ends in .jpg/.jpeg, automatically
 * retry by fetching the same URL with the extension replaced by .png.
 * This handles CDNs (e.g. Apple Music) that serve the same artwork as both JPEG
 * and PNG depending on the URL extension.
 */
async function _decodeWithJpegFallback(buffer, finalUrl) {
  try {
    return _decode(buffer);
  } catch (err) {
    if (_isJpeg(buffer)) {
      // Replace .jpg / .jpeg at the very end of the URL path (before ? # or end)
      const pngUrl = finalUrl.replace(/\.jpe?g(?=[?#]|$)/i, '.png');
      if (pngUrl !== finalUrl) {
        const { buffer: pngBuffer } = await _fetchBuffer(pngUrl);
        return _decode(pngBuffer);
      }
    }
    throw err;
  }
}

/**
 * Fetch a URL and return { buffer, finalUrl } where finalUrl is the URL
 * actually used after following all redirects.
 * Follows up to 3 redirects.
 *
 * @param {string} url
 * @param {number} [redirectsLeft]
 * @returns {Promise<{buffer: Buffer, finalUrl: string}>}
 */
function _fetchBuffer(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (_) {
      reject(new Error(`Invalid image URL: ${url}`));
      return;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      reject(new Error('Unsupported URL protocol — only http and https are allowed'));
      return;
    }
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req    = client.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects fetching image'));
        let nextUrl;
        try {
          nextUrl = new URL(res.headers.location, parsedUrl).toString();
        } catch (_) {
          return reject(new Error('Invalid redirect URL while fetching image'));
        }
        return _fetchBuffer(nextUrl, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} while fetching image from URL`));
      }
      const contentLength = Number(res.headers['content-length'] || 0);
      if (contentLength > MAX_FETCH_BYTES) {
        req.destroy();
        return reject(
          new Error(`Image is too large (${contentLength} bytes). Max allowed is ${MAX_FETCH_BYTES} bytes`),
        );
      }
      const chunks = [];
      let totalBytes = 0;
      res.on('data',  (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_FETCH_BYTES) {
          req.destroy(new Error(`Image exceeds max size of ${MAX_FETCH_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end',   ()      => resolve({ buffer: Buffer.concat(chunks), finalUrl: url }));
      res.on('error', reject);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('Image fetch timed out after 10 s')));
    req.on('error', reject);
  });
}

// ─── PNG decoder ───────────────────────────────────────────────────────────────

/**
 * Decode a PNG buffer to { width, height, pixels } where pixels is a
 * Buffer of width*height*3 bytes (R, G, B order, top-left to bottom-right).
 * Supports 8-bit RGB (colorType 2) and 8-bit RGBA (colorType 6).
 */
function _decodePng(buffer) {
  let width, height, bitDepth, colorType;
  const idatChunks = [];
  let offset = 8; // skip 8-byte magic signature

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type   = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data   = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width     = data.readUInt32BE(0);
      height    = data.readUInt32BE(4);
      bitDepth  = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length; // 4(len) + 4(type) + N(data) + 4(CRC)
  }

  if (!width || !height) throw new Error('Invalid PNG: missing IHDR chunk');
  _assertImageBounds(width, height, 'PNG');

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `Unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} — only 8-bit RGB/RGBA accepted`,
    );
  }

  const channels = colorType === 6 ? 4 : 3; // RGBA vs RGB

  // Inflate all IDAT chunks (concatenated zlib stream)
  const raw     = zlib.inflateSync(Buffer.concat(idatChunks));
  const expectedRawLength = height * (1 + width * channels);
  if (raw.length !== expectedRawLength) {
    throw new Error('Invalid PNG: unexpected uncompressed data size');
  }
  const pixels  = Buffer.alloc(width * height * 3);
  const prevRow = Buffer.alloc(width * channels, 0);
  let rawPos    = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const stride = width * channels;
    const rowSrc = raw.subarray(rawPos, rawPos + stride);
    rawPos += stride;

    // Reconstruct filtered row
    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[x - channels] : 0; // pixel to the left (same channel)
      const b = prevRow[x];                               // pixel above
      const c = x >= channels ? prevRow[x - channels] : 0; // pixel above-left
      let val;
      switch (filter) {
        case 0: val = rowSrc[x];                                  break; // None
        case 1: val = rowSrc[x] + a;                              break; // Sub
        case 2: val = rowSrc[x] + b;                              break; // Up
        case 3: val = rowSrc[x] + Math.floor((a + b) / 2);       break; // Average
        case 4: val = rowSrc[x] + _paethPredictor(a, b, c);      break; // Paeth
        default: throw new Error(`Unknown PNG filter type ${filter}`);
      }
      recon[x] = val & 0xFF;
    }

    // Extract RGB; for RGBA composite over black using the alpha channel
    for (let x = 0; x < width; x++) {
      const pi = (y * width + x) * 3;
      const ri = x * channels;
      if (channels === 4) {
        const a      = recon[ri + 3] / 255;
        pixels[pi]     = Math.round(recon[ri]     * a);
        pixels[pi + 1] = Math.round(recon[ri + 1] * a);
        pixels[pi + 2] = Math.round(recon[ri + 2] * a);
      } else {
        pixels[pi]     = recon[ri];
        pixels[pi + 1] = recon[ri + 1];
        pixels[pi + 2] = recon[ri + 2];
      }
    }

    recon.copy(prevRow);
  }

  return { width, height, pixels };
}

function _paethPredictor(a, b, c) {
  const p  = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Like _decodePng but outputs RGBA (4 bytes/pixel) — alpha is preserved as-is,
 * with no pre-multiplication against black.
 */
function _decodePngRgba(buffer) {
  let width, height, bitDepth, colorType;
  const idatChunks = [];
  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type   = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data   = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width     = data.readUInt32BE(0);
      height    = data.readUInt32BE(4);
      bitDepth  = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!width || !height) throw new Error('Invalid PNG: missing IHDR chunk');
  _assertImageBounds(width, height, 'PNG');
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw     = zlib.inflateSync(Buffer.concat(idatChunks));
  const expectedRawLength = height * (1 + width * channels);
  if (raw.length !== expectedRawLength) {
    throw new Error('Invalid PNG: unexpected uncompressed data size');
  }
  const pixels  = Buffer.alloc(width * height * 4); // RGBA output
  const prevRow = Buffer.alloc(width * channels, 0);
  let rawPos    = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const stride = width * channels;
    const rowSrc = raw.subarray(rawPos, rawPos + stride);
    rawPos += stride;

    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[x - channels] : 0;
      const b = prevRow[x];
      const c = x >= channels ? prevRow[x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = rowSrc[x];                                  break;
        case 1: val = rowSrc[x] + a;                              break;
        case 2: val = rowSrc[x] + b;                              break;
        case 3: val = rowSrc[x] + Math.floor((a + b) / 2);       break;
        case 4: val = rowSrc[x] + _paethPredictor(a, b, c);      break;
        default: throw new Error(`Unknown PNG filter type ${filter}`);
      }
      recon[x] = val & 0xFF;
    }

    for (let x = 0; x < width; x++) {
      const pi = (y * width + x) * 4;
      const ri = x * channels;
      pixels[pi]     = recon[ri];
      pixels[pi + 1] = recon[ri + 1];
      pixels[pi + 2] = recon[ri + 2];
      pixels[pi + 3] = channels === 4 ? recon[ri + 3] : 255;
    }

    recon.copy(prevRow);
  }

  return { width, height, pixels };
}

// ─── GIF decoder ───────────────────────────────────────────────────────────────

/**
 * Decode a GIF buffer to { width, height, pixels }.
 * Decodes only the first image frame.
 * Handles interlaced images and local/global color tables.
 */
function _decodeGif(buffer) {
  const sig = buffer.subarray(0, 6).toString('ascii');
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('Invalid GIF signature');

  // logicalWidth / logicalHeight (bytes 6–9) not needed — individual frames carry their own dimensions
  const packed        = buffer.readUInt8(10);
  const hasGCT        = (packed >> 7) & 1;
  const gctEntries    = hasGCT ? (1 << ((packed & 0x07) + 1)) : 0;

  let globalCT = null;
  let offset   = 13;

  if (hasGCT) {
    globalCT = buffer.subarray(offset, offset + gctEntries * 3);
    offset  += gctEntries * 3;
  }

  // Walk blocks to find the first Image Descriptor (0x2C)
  while (offset < buffer.length) {
    const blockId = buffer.readUInt8(offset);

    if (blockId === 0x3B) break; // GIF Trailer

    // Extension block — skip
    if (blockId === 0x21) {
      offset += 2; // introducer (0x21) + label
      while (offset < buffer.length) {
        const sz = buffer.readUInt8(offset++);
        if (sz === 0) break;
        offset += sz;
      }
      continue;
    }

    // Image Descriptor
    if (blockId === 0x2C) {
      offset++; // skip 0x2C separator
      // left(2) top(2) width(2) height(2) flags(1)
      offset     += 2; // left  (ignored)
      offset     += 2; // top   (ignored)
      const imgW  = buffer.readUInt16LE(offset); offset += 2;
      const imgH  = buffer.readUInt16LE(offset); offset += 2;
      _assertImageBounds(imgW, imgH, 'GIF frame');
      const flags = buffer.readUInt8(offset++);

      const hasLCT      = (flags >> 7) & 1;
      const isInterlaced = (flags >> 6) & 1;
      const lctEntries  = hasLCT ? (1 << ((flags & 0x07) + 1)) : 0;

      let colorTable = globalCT;
      if (hasLCT) {
        colorTable = buffer.subarray(offset, offset + lctEntries * 3);
        offset    += lctEntries * 3;
      }
      if (!colorTable) throw new Error('GIF has no color table');

      // LZW minimum code size
      const minCodeSize = buffer.readUInt8(offset++);

      // Collect sub-blocks into a flat byte array
      const lzwData = [];
      while (offset < buffer.length) {
        const sz = buffer.readUInt8(offset++);
        if (sz === 0) break;
        for (let i = 0; i < sz; i++) lzwData.push(buffer.readUInt8(offset++));
      }

      // LZW decompress → palette indices
      let indices = _lzwDecompress(lzwData, minCodeSize);

      // Deinterlace if needed
      if (isInterlaced) indices = _deinterlace(indices, imgW, imgH);

      // Map palette indices to RGB
      const pixels = Buffer.alloc(imgW * imgH * 3);
      for (let i = 0; i < imgW * imgH; i++) {
        const ci    = (indices[i] || 0) * 3;
        pixels[i * 3]     = colorTable[ci];
        pixels[i * 3 + 1] = colorTable[ci + 1];
        pixels[i * 3 + 2] = colorTable[ci + 2];
      }

      return { width: imgW, height: imgH, pixels };
    }

    // Unknown block — skip byte
    offset++;
  }

  throw new Error('No image frame found in GIF');
}

/**
 * GIF LZW decompressor.
 * Returns an array of palette indices.
 *
 * @param {number[]} data        Flat array of LZW-compressed bytes
 * @param {number}   minCodeSize LZW minimum code size
 * @returns {number[]}
 */
function _lzwDecompress(data, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eofCode   = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = eofCode + 1;
  const table  = [];

  const reset = () => {
    table.length = 0;
    for (let i = 0; i < clearCode; i++) table[i] = [i];
    table[clearCode] = [];
    table[eofCode]   = [];
    codeSize = minCodeSize + 1;
    nextCode = eofCode + 1;
  };
  reset();

  const output   = [];
  let bits       = 0;
  let bitCount   = 0;
  let bytePos    = 0;
  let prevCode   = -1;

  const readCode = () => {
    while (bitCount < codeSize && bytePos < data.length) {
      bits     |= data[bytePos++] << bitCount;
      bitCount += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits      = bits >>> codeSize;
    bitCount -= codeSize;
    return code;
  };

  while (true) {
    const code = readCode();
    if (code === eofCode) break;

    if (code === clearCode) {
      reset();
      prevCode = -1;
      continue;
    }

    let entry;
    if (code < nextCode) {
      entry = table[code];
    } else if (code === nextCode && prevCode >= 0) {
      const prev = table[prevCode];
      entry = [...prev, prev[0]];
    } else {
      break; // corrupt stream
    }

    for (const c of entry) output.push(c);

    if (prevCode >= 0 && nextCode < 4096) {
      const prev = table[prevCode];
      table[nextCode++] = [...prev, entry[0]];
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    }

    prevCode = code;
  }

  return output;
}

/**
 * Reorder GIF interlaced scan lines to sequential order.
 * GIF interlacing uses 4 passes: every 8th row starting at 0, 4, 2, then 1.
 */
function _deinterlace(indices, width, height) {
  const out = new Array(width * height);
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ];
  let src = 0;
  for (const { start, step } of passes) {
    for (let y = start; y < height; y += step) {
      for (let x = 0; x < width; x++) {
        out[y * width + x] = indices[src++];
      }
    }
  }
  return out;
}

/**
 * Decode all frames of a GIF buffer to an array of RGBA frame objects.
 * Handles GCE transparent color index and per-frame delay.
 * Does not composite partial frames onto a background (each frame is decoded
 * independently at its own dimensions), which is correct for most animated icons.
 */
function _decodeGifFrames(buffer) {
  const sig = buffer.subarray(0, 6).toString('ascii');
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('Invalid GIF signature');

  const packed     = buffer.readUInt8(10);
  const hasGCT     = (packed >> 7) & 1;
  const gctEntries = hasGCT ? (1 << ((packed & 0x07) + 1)) : 0;

  let globalCT = null;
  let offset   = 13;

  if (hasGCT) {
    globalCT = buffer.subarray(offset, offset + gctEntries * 3);
    offset  += gctEntries * 3;
  }

  const frames          = [];
  let gceDelay          = 10;  // centiseconds default (= 100 ms)
  let gceTransparentIdx = -1;  // -1 = no transparency

  while (offset < buffer.length) {
    const blockId = buffer.readUInt8(offset);
    if (blockId === 0x3B) break; // GIF Trailer

    if (blockId === 0x21) {
      const label = buffer.readUInt8(offset + 1);
      offset += 2;

      if (label === 0xF9) {
        // Graphic Control Extension — read as sub-block(s)
        const sz = buffer.readUInt8(offset++);
        if (sz >= 4) {
          const gcePacked       = buffer.readUInt8(offset);
          gceDelay              = buffer.readUInt16LE(offset + 1);
          gceTransparentIdx     = (gcePacked & 1) ? buffer.readUInt8(offset + 3) : -1;
        }
        offset += sz;
        // Drain remaining sub-blocks (terminator 0x00)
        while (offset < buffer.length) {
          const s = buffer.readUInt8(offset++);
          if (s === 0) break;
          offset += s;
        }
      } else {
        // Other extensions — skip all sub-blocks
        while (offset < buffer.length) {
          const s = buffer.readUInt8(offset++);
          if (s === 0) break;
          offset += s;
        }
      }
      continue;
    }

    if (blockId === 0x2C) {
      offset++; // skip 0x2C separator
      const imgLeft = buffer.readUInt16LE(offset); offset += 2;
      const imgTop  = buffer.readUInt16LE(offset); offset += 2;
      const imgW    = buffer.readUInt16LE(offset); offset += 2;
      const imgH    = buffer.readUInt16LE(offset); offset += 2;
      _assertImageBounds(imgW, imgH, 'GIF frame');
      const flags   = buffer.readUInt8(offset++);

      const hasLCT       = (flags >> 7) & 1;
      const isInterlaced = (flags >> 6) & 1;
      const lctEntries   = hasLCT ? (1 << ((flags & 0x07) + 1)) : 0;

      let colorTable = globalCT;
      if (hasLCT) {
        colorTable = buffer.subarray(offset, offset + lctEntries * 3);
        offset    += lctEntries * 3;
      }
      if (!colorTable) throw new Error('GIF has no color table');

      const minCodeSize = buffer.readUInt8(offset++);
      const lzwData     = [];
      while (offset < buffer.length) {
        const sz = buffer.readUInt8(offset++);
        if (sz === 0) break;
        for (let i = 0; i < sz; i++) lzwData.push(buffer.readUInt8(offset++));
      }

      let indices = _lzwDecompress(lzwData, minCodeSize);
      if (isInterlaced) indices = _deinterlace(indices, imgW, imgH);

      const transIdx = gceTransparentIdx;
      const pixels   = Buffer.alloc(imgW * imgH * 4, 0);
      for (let i = 0; i < imgW * imgH; i++) {
        const ci = indices[i] || 0;
        if (transIdx >= 0 && ci === transIdx) {
          // Transparent — leave as [0,0,0,0]
        } else {
          const t         = ci * 3;
          pixels[i * 4]     = colorTable[t];
          pixels[i * 4 + 1] = colorTable[t + 1];
          pixels[i * 4 + 2] = colorTable[t + 2];
          pixels[i * 4 + 3] = 255;
        }
      }

      frames.push({
        width:   imgW,
        height:  imgH,
        left:    imgLeft,
        top:     imgTop,
        pixels,
        delayMs: Math.max(20, gceDelay * 10),
      });

      // Reset GCE state for next frame
      gceDelay          = 10;
      gceTransparentIdx = -1;
      continue;
    }

    offset++; // Unknown block — skip byte
  }

  if (frames.length === 0) throw new Error('No image frames found in GIF');
  return frames;
}

// ─── Resize ────────────────────────────────────────────────────────────────────

/**
 * Resize raw RGB pixel data to PIXOO_SIZE × PIXOO_SIZE.
 * Delegates to the public resizeRgb helper.
 */
function _resizeTo64(pixels, srcW, srcH) {
  return resizeRgb(pixels, srcW, srcH, PIXOO_SIZE, PIXOO_SIZE);
}
