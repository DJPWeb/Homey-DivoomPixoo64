'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Tiny font (hand-coded 3×5) ─────────────────────────────────────────────
//
// Base glyph table: 3 wide × 5 tall.
// Each glyph is 5 rows of 3 bits.
// Bit 2 = leftmost column, bit 1 = middle column, bit 0 = rightmost column.
//
// Text rendered uppercase; accented chars stripped to base form.

const GLYPHS = {
  'A': [2,    5,    7,    5,    5],
  'B': [6,    5,    6,    5,    6],
  'C': [7,    4,    4,    4,    7],
  'D': [6,    5,    5,    5,    6],
  'E': [7,    4,    6,    4,    7],
  'F': [7,    4,    6,    4,    4],
  'G': [6,    4,    5,    5,    7],
  'H': [5,    5,    7,    5,    5],
  'I': [7,    2,    2,    2,    7],
  'J': [3,    1,    1,    5,    2],
  'K': [5,    6,    4,    6,    5],
  'L': [4,    4,    4,    4,    7],
  'M': [5,    7,    5,    5,    5],
  'N': [6,    5,    5,    5,    5],
  'O': [2,    5,    5,    5,    2],
  'P': [6,    5,    6,    4,    4],
  'Q': [2,    5,    5,    6,    3],
  'R': [6,    5,    6,    5,    5],
  'S': [3,    4,    2,    1,    6],
  'T': [7,    2,    2,    2,    2],
  'U': [5,    5,    5,    5,    7],
  'V': [5,    5,    5,    5,    2],
  'W': [5,    5,    5,    7,    2],
  'X': [5,    5,    2,    5,    5],
  'Y': [5,    5,    2,    2,    2],
  'Z': [7,    1,    2,    4,    7],
  '0': [7,    5,    5,    5,    7],
  '1': [2,    6,    2,    2,    7],
  '2': [7,    1,    7,    4,    7],
  '3': [7,    1,    7,    1,    7],
  '4': [5,    5,    7,    1,    1],
  '5': [7,    4,    7,    1,    7],
  '6': [3,    4,    7,    5,    7],
  '7': [7,    1,    1,    1,    1],
  '8': [7,    5,    7,    5,    7],
  '9': [7,    5,    7,    1,    7],
  ' ': [0,    0,    0,    0,    0],
  '.': [0,    0,    0,    0,    1],
  ',': [0,    0,    0,    1,    2],
  '!': [1,    1,    1,    0,    1],
  '?': [6,    1,    2,    0,    2],
  ':': [0,    1,    0,    1,    0],
  ';': [0,    1,    0,    1,    2],
  '-': [0,    0,    7,    0,    0],
  '_': [0,    0,    0,    0,    7],
  '/': [1,    1,    2,    4,    4],
  '(': [2,    4,    4,    4,    2],
  ')': [2,    1,    1,    1,    2],
  '+': [0,    2,    7,    2,    0],
  '=': [0,    7,    0,    7,    0],
  '#': [5,    7,    5,    7,    5],
  "'": [1,    1,    0,    0,    0],
  '"': [5,    5,    0,    0,    0],
  '*': [5,    2,    7,    2,    5],
  '%': [5,    1,    2,    4,    5],
  '<': [1,    2,    4,    2,    1],
  '>': [4,    2,    1,    2,    4],
  '@': [2,    5,    7,    4,    3],
  '°': [1,    0,    0,    0,    0],
  '|': [1,    1,    1,    1,    1],
};

const GLYPH_WIDTHS = {
  ' ':  2,
  '.':  1,
  ',':  2,
  '!':  1,
  "'":  1,
  ':':  1,
  ';':  2,
  '°':  1,
  '|':  1,
};

const BASE_W = 3;
const BASE_H = 5;

const FONT_SIZES = {
  tiny: { charW: 3, charH: 5, gap: 1 },
};

function _destW(srcW, charW) {
  return Math.round(srcW * charW / BASE_W);
}

// ─── PNG font system ─────────────────────────────────────────────────────────
//
// Font sheets live in assets/fonts/<Name>.png.
// Format:
//   background  #000088 → transparent
//   lit pixels  #FCFCFC → replaced by user colour at render time
//   char marker #FC00FC at column-start, row 0 → marks left edge of each glyph
//
// Characters are laid out in ASCII order from ! (33) to ~ (126) = 94 chars.
// Space width is derived from the '_' glyph.
// Glyphs are stored as full fixed-width cells; proportional rendering crops each
// glyph to its lit-pixel bounding box (left/right) at draw time, then adds PNG_GAP.

const PNG_GAP = 1; // pixels between glyphs after proportional crop

// CHAR_ORDER: ASCII 33 ('!') → 126 ('~'), 94 characters total
const CHAR_ORDER = (function () {
  let s = '';
  for (let i = 33; i <= 126; i++) s += String.fromCharCode(i);
  return s;
}());

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');

// Loaded font data, keyed by lowercase name.
const _fontCache = new Map();

// ── PNG decoder ──────────────────────────────────────────────────────────────

function _paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

/**
 * Minimal PNG decoder.
 * Returns { width, height, pixels: Uint8Array } — packed RGB (3 bytes/pixel).
 * Supports colour types 0 (greyscale), 2 (RGB), 3 (indexed), 6 (RGBA).
 */
function _parsePNG(buf) {
  let pos = 8; // skip 8-byte signature
  let width, height, colorType;
  const idatChunks = [];
  let palette = null;

  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos); pos += 4;
    const type   = buf.slice(pos, pos + 4).toString('ascii'); pos += 4;
    const data   = buf.slice(pos, pos + length); pos += length;
    pos += 4; // skip CRC

    if      (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'PLTE') { palette = data; }
    else if (type === 'IDAT') { idatChunks.push(data); }
    else if (type === 'IEND') { break; }
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));

  // Raw bytes per pixel (before palette expansion)
  const bpp    = (colorType === 2) ? 3 : (colorType === 6) ? 4 : 1;
  const stride = width * bpp + 1; // +1 for the per-row filter byte
  const recon  = Buffer.alloc(height * width * bpp);

  for (let y = 0; y < height; y++) {
    const ft = raw[y * stride];
    const rl = raw.subarray(y * stride + 1, y * stride + 1 + width * bpp);
    const cl = recon.subarray(y * width * bpp, (y + 1) * width * bpp);
    const pl = y > 0 ? recon.subarray((y - 1) * width * bpp, y * width * bpp) : Buffer.alloc(width * bpp);

    for (let x = 0; x < width * bpp; x++) {
      const a = x >= bpp ? cl[x - bpp] : 0;
      const b = pl[x];
      const c = x >= bpp ? pl[x - bpp] : 0;
      let v = rl[x];
      if      (ft === 1) v = (v + a) & 0xFF;
      else if (ft === 2) v = (v + b) & 0xFF;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 0xFF;
      else if (ft === 4) v = (v + _paeth(a, b, c)) & 0xFF;
      cl[x] = v;
    }
  }

  // Expand to packed RGB
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * width * bpp + x * bpp;
      const dst = (y * width + x) * 3;
      if (colorType === 3) {          // indexed → PLTE lookup
        const pi    = recon[src] * 3;
        pixels[dst]   = palette[pi];
        pixels[dst+1] = palette[pi+1];
        pixels[dst+2] = palette[pi+2];
      } else if (colorType === 2) {   // RGB
        pixels[dst]   = recon[src];
        pixels[dst+1] = recon[src+1];
        pixels[dst+2] = recon[src+2];
      } else if (colorType === 6) {   // RGBA (drop alpha)
        pixels[dst]   = recon[src];
        pixels[dst+1] = recon[src+1];
        pixels[dst+2] = recon[src+2];
      } else {                        // greyscale
        const v = recon[src];
        pixels[dst] = pixels[dst+1] = pixels[dst+2] = v;
      }
    }
  }

  return { width, height, pixels };
}

// ── Font sheet parser ─────────────────────────────────────────────────────────

/**
 * Parse a PNG font sheet into a glyph map.
 * Returns { glyphs: Map<char, {w, h, rows: Uint8Array[], left, right}>, height }.
 * left/right are the proportional bounding-box column indices of lit pixels.
 */
function _parseFontSheet(buf) {
  const { width, height, pixels } = _parsePNG(buf);

  // Find violet (#FC00FC) marker pixels in row 0 — each marks a glyph's left edge
  const markers = [];
  for (let x = 0; x < width; x++) {
    const i = x * 3;
    if (pixels[i] >= 0xF0 && pixels[i+1] <= 0x10 && pixels[i+2] >= 0xF0) {
      markers.push(x);
    }
  }

  const glyphs = new Map();
  const count  = Math.min(markers.length, CHAR_ORDER.length);

  for (let ci = 0; ci < count; ci++) {
    const ch = CHAR_ORDER[ci];
    const x0 = markers[ci];
    const x1 = ci + 1 < markers.length ? markers[ci + 1] : width;
    const w  = x1 - x0;

    const rows = [];
    let left = w, right = -1;

    for (let row = 0; row < height; row++) {
      const cols = new Uint8Array(w);
      for (let col = 0; col < w; col++) {
        const i = (row * width + x0 + col) * 3;
        // Lit = near-white (#FCFCFC); background blue and violet marker → transparent
        if (pixels[i] >= 0xF0 && pixels[i+1] >= 0xF0 && pixels[i+2] >= 0xF0) {
          cols[col] = 1;
          if (col < left)  left  = col;
          if (col > right) right = col;
        }
      }
      rows.push(cols);
    }

    // Empty glyph (no lit pixels) — give it a 1-column zero-width slot
    if (right < 0) { left = 0; right = -1; }

    glyphs.set(ch, { w, h: height, rows, left, right });
  }

  // Space: proportional width of '_' (its bounding box), all pixels off
  const under = glyphs.get('_');
  if (under) {
    const sw = under.right >= 0 ? under.right - under.left + 1 : 4;
    glyphs.set(' ', { w: sw, h: height, rows: Array.from({ length: height }, () => new Uint8Array(sw)), left: 0, right: sw - 1 });
  }

  return { glyphs, height };
}

// ── Font loader (lazy + cached) ───────────────────────────────────────────────

function _loadPNGFont(name) {
  const key = name.toLowerCase();
  if (_fontCache.has(key)) return _fontCache.get(key);

  let filePath;
  try {
    const files = fs.readdirSync(FONTS_DIR);
    const match = files.find(f => f.toLowerCase() === key + '.png');
    if (!match) return null;
    filePath = path.join(FONTS_DIR, match);
  } catch { return null; }

  try {
    const data = _parseFontSheet(fs.readFileSync(filePath));
    _fontCache.set(key, data);
    return data;
  } catch (err) {
    console.error(`[PixelFont] Failed to load "${name}": ${err.message}`);
    return null;
  }
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

// Tiny font: uppercase + strip accents (font has uppercase only)
function _normalizeTiny(text) {
  return String(text).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// PNG fonts: strip accents only — font has both A-Z and a-z
function _normalizePNG(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render text onto a 64×64×3 RGB canvas buffer (in place).
 *
 * - Tiny: text is uppercased and accent marks are stripped.
 * - PNG fonts: accent marks are stripped; case is preserved.
 * - Characters absent from the font are silently skipped.
 * - Pixels outside the 64×64 grid are clipped.
 * - startX may be negative (scrolling use-case).
 *
 * @param {string} text      Text to render
 * @param {string} hexColor  CSS hex colour, e.g. "#FF0000"
 * @param {Buffer} canvas    64×64×3 RGB buffer (mutated in place)
 * @param {number} startX    Left edge column
 * @param {number} startY    Top edge row
 * @param {string} fontName  'tiny' | PNG font name, e.g. 'Victoria'  (default: 'tiny')
 * @returns {Buffer}         The mutated canvas
 */
function renderText(text, hexColor, canvas, startX, startY, fontName = 'tiny') {
  if (fontName.toLowerCase() === 'tiny') {
    return _renderTiny(text, hexColor, canvas, startX, startY);
  }
  const font = _loadPNGFont(fontName);
  if (!font) return _renderTiny(text, hexColor, canvas, startX, startY);
  return _renderPNG(text, hexColor, canvas, startX, startY, font);
}

/**
 * Calculate the pixel width of a rendered text string.
 *
 * @param {string} text
 * @param {string} fontName  'tiny' | PNG font name
 * @returns {number}
 */
function measureText(text, fontName = 'tiny') {
  if (fontName.toLowerCase() === 'tiny') return _measureTiny(text);
  const font = _loadPNGFont(fontName);
  if (!font) return _measureTiny(text);
  return _measurePNG(text, font);
}

// ─── Tiny render / measure ────────────────────────────────────────────────────

function _renderTiny(text, hexColor, canvas, startX, startY) {
  const { charW, charH, gap } = FONT_SIZES.tiny;

  const h = (hexColor || '#ffffff').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;

  const normalized = _normalizeTiny(text);

  let cx = Math.round(startX);
  const cy = Math.round(startY);

  for (const ch of normalized) {
    if (cx >= 64) break;

    const glyph = GLYPHS[ch];
    const srcW  = GLYPH_WIDTHS[ch] !== undefined ? GLYPH_WIDTHS[ch] : BASE_W;
    const dw    = _destW(srcW, charW);

    if (glyph === undefined || cx + dw <= 0) {
      cx += dw + gap;
      continue;
    }

    for (let destRow = 0; destRow < charH; destRow++) {
      const py = cy + destRow;
      if (py < 0 || py >= 64) continue;

      const srcRow  = Math.floor(destRow * BASE_H / charH);
      const rowBits = glyph[srcRow];

      for (let destCol = 0; destCol < dw; destCol++) {
        const px = cx + destCol;
        if (px < 0 || px >= 64) continue;

        const srcCol = Math.floor(destCol * srcW / dw);
        if (!((rowBits >> (srcW - 1 - srcCol)) & 1)) continue;

        const idx       = (py * 64 + px) * 3;
        canvas[idx]     = r;
        canvas[idx + 1] = g;
        canvas[idx + 2] = b;
      }
    }

    cx += dw + gap;
  }

  return canvas;
}

function _measureTiny(text) {
  const { charW, gap } = FONT_SIZES.tiny;
  const normalized = _normalizeTiny(text);
  let total = 0, count = 0;
  for (const ch of normalized) {
    const srcW = GLYPH_WIDTHS[ch] !== undefined ? GLYPH_WIDTHS[ch] : BASE_W;
    total += _destW(srcW, charW) + gap;
    count++;
  }
  return count === 0 ? 0 : total - gap;
}

// ─── PNG render / measure ─────────────────────────────────────────────────────

function _renderPNG(text, hexColor, canvas, startX, startY, font) {
  const h = (hexColor || '#ffffff').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;

  const normalized = _normalizePNG(text);

  let cx = Math.round(startX);
  const cy = Math.round(startY);

  for (const ch of normalized) {
    if (cx >= 64) break;

    // Try exact case first; fall back to uppercase for fonts without lowercase
    const glyph = font.glyphs.get(ch) || font.glyphs.get(ch.toUpperCase());
    if (!glyph) continue;

    const glyphW = glyph.right >= 0 ? glyph.right - glyph.left + 1 : 0;

    if (glyph.right >= 0 && cx + glyphW > 0) {
      for (let row = 0; row < glyph.h; row++) {
        const py = cy + row;
        if (py < 0 || py >= 64) continue;

        const cols = glyph.rows[row];
        for (let col = glyph.left; col <= glyph.right; col++) {
          if (!cols[col]) continue;

          const px = cx + (col - glyph.left);
          if (px < 0 || px >= 64) continue;

          const idx     = (py * 64 + px) * 3;
          canvas[idx]   = r;
          canvas[idx+1] = g;
          canvas[idx+2] = b;
        }
      }
    }

    cx += glyphW + PNG_GAP;
  }

  return canvas;
}

function _measurePNG(text, font) {
  const normalized = _normalizePNG(text);
  let total = 0, count = 0;
  for (const ch of normalized) {
    const glyph = font.glyphs.get(ch) || font.glyphs.get(ch.toUpperCase());
    if (!glyph) continue;
    total += (glyph.right >= 0 ? glyph.right - glyph.left + 1 : 0) + PNG_GAP;
    count++;
  }
  return count === 0 ? 0 : total - PNG_GAP; // strip trailing gap
}

module.exports = { renderText, measureText, FONT_SIZES };
