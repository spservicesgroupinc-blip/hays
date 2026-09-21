const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 implementation
const table = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
  table[i] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

function makePng(width, height, getPixel) {
  const rowLen = 1 + width * 4;
  const raw = Buffer.alloc(height * rowLen);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowLen;
    raw[rowOffset] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y, width, height);
      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type);
    const typeAndData = Buffer.concat([typeBuf, data]);
    const crcVal = crc32(typeAndData);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);
    return Buffer.concat([len, typeAndData, crcBuf]);
  }

  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 8-bit
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // Deflate
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // No interlace

  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([header, ihdrChunk, idatChunk, iendChunk]);
}

// Helper math functions for rendering
function dist(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function renderFieldProofIcon(x, y, width, height, isMaskable) {
  // Normalize coords to [-1, 1]
  const nx = (x / width) * 2 - 1;
  const ny = (y / height) * 2 - 1;

  // Background: Deep dark slate (#0F172A to #020617)
  const bgR = Math.round(15 - ny * 5);
  const bgG = Math.round(23 - ny * 8);
  const bgB = Math.round(42 - ny * 12);

  // If not maskable, we can round outer corners
  if (!isMaskable) {
    const cornerRadius = 0.28;
    const qx = Math.abs(nx) - (1 - cornerRadius);
    const qy = Math.abs(ny) - (1 - cornerRadius);
    if (qx > 0 && qy > 0 && Math.hypot(qx, qy) > cornerRadius) {
      return [0, 0, 0, 0]; // transparent outside squircle
    }
  }

  // Scaling factor: maskable fits safely within 80% circle
  const scale = isMaskable ? 0.76 : 0.88;
  const sx = nx / scale;
  const sy = (ny + (isMaskable ? 0.02 : 0.03)) / scale; // slight vertical optical center

  // Distance from center
  const dCenter = Math.hypot(sx, sy);

  // Check shield geometry
  // Shield top from sy = -0.72 to sy = 0.72
  let inShield = false;
  let inShieldBorder = false;

  if (sy >= -0.72 && sy <= 0.68) {
    const halfWidth = sy < 0.05 
      ? 0.58 
      : 0.58 * Math.cos(((sy - 0.05) / 0.63) * (Math.PI / 2));

    if (Math.abs(sx) <= halfWidth) {
      inShield = true;
      const borderThickness = 0.04;
      if (Math.abs(sx) >= halfWidth - borderThickness || sy <= -0.68 || sy >= 0.64) {
        inShieldBorder = true;
      }
    }
  }

  // Hays White Cross (+) at top of shield
  const crossX = sx;
  const crossY = sy + 0.46;
  const inCrossV = Math.abs(crossX) <= 0.03 && Math.abs(crossY) <= 0.10;
  const inCrossH = Math.abs(crossX) <= 0.08 && Math.abs(crossY) <= 0.03;
  if (inCrossV || inCrossH) {
    return [255, 255, 255, 255];
  }

  // Camera Aperture Lens at sy = -0.02
  const lensY = sy + 0.02;
  const dLens = Math.hypot(sx, lensY);

  // Checkmark inside camera lens
  // Points: (-0.14, 0.02) -> (-0.02, 0.12) -> (0.16, -0.08)
  const px = sx;
  const py = lensY;
  let onCheck = false;

  // Segment 1: from (-0.12, 0.0) to (-0.02, 0.10)
  // Distance to line segment
  function distToSegment(x, y, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return Math.hypot(x - x1, y - y1);
    let t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1)));
  }

  const dCheck1 = distToSegment(px, py, -0.12, 0.00, -0.02, 0.10);
  const dCheck2 = distToSegment(px, py, -0.02, 0.10, 0.14, -0.08);
  if (dCheck1 <= 0.032 || dCheck2 <= 0.032) {
    onCheck = true;
  }

  if (onCheck) {
    return [34, 197, 94, 255]; // Vibrant Emerald #22C55E
  }

  // Inner Lens Aperture Ring
  if (dLens <= 0.28) {
    // Lens aperture center
    if (dLens <= 0.18) {
      return [15, 23, 42, 255]; // Deep aperture #0F172A
    }
    // Gold Aperture ring
    if (dLens <= 0.24) {
      return [234, 179, 8, 255]; // Gold #EAB308
    }
    return [30, 41, 59, 255]; // Outer lens dark #1E293B
  }

  if (inShield) {
    if (inShieldBorder) {
      return [255, 255, 255, 220]; // Shield highlight
    }
    // Gradient Red (#DC2626 -> #991B1B)
    const redG = Math.round(200 - sy * 40);
    return [redG, 29, 37, 255];
  }

  return [bgR, bgG, bgB, 255];
}

const pubDir = path.resolve(__dirname, '../public');
if (!fs.existsSync(pubDir)) {
  fs.mkdirSync(pubDir, { recursive: true });
}

// Generate PWA icons
const icons = [
  { name: 'apple-touch-icon.png', size: 180, maskable: false },
  { name: 'pwa-192x192.png', size: 192, maskable: false },
  { name: 'pwa-512x512.png', size: 512, maskable: false },
  { name: 'pwa-maskable-512x512.png', size: 512, maskable: true },
  { name: 'favicon-32x32.png', size: 32, maskable: false },
  { name: 'favicon-16x16.png', size: 16, maskable: false },
];

for (const icon of icons) {
  const buf = makePng(icon.size, icon.size, (x, y, w, h) => 
    renderFieldProofIcon(x, y, w, h, icon.maskable)
  );
  fs.writeFileSync(path.join(pubDir, icon.name), buf);
  console.log(`Generated ${icon.name} (${icon.size}x${icon.size}) - ${buf.length} bytes`);
}

// Copy 32x32 as favicon.ico for standard fallback
fs.copyFileSync(path.join(pubDir, 'favicon-32x32.png'), path.join(pubDir, 'favicon.ico'));
console.log('Copied favicon.ico');

// Cleanup temporary test file
const testFile = path.join(pubDir, 'test.png');
if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
console.log('Done generating all PWA assets.');
