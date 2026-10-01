'use strict';
// Original code-drawn mark; no fonts, remote assets, or image dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect x="8" y="8" width="240" height="240" rx="56" fill="#101a20"/><path d="M80 199V67h52a42 42 0 0 1 0 84h-27v48Z" fill="#bedfce"/><path d="M105 89h25a20 20 0 0 1 0 40h-25Z" fill="#101a20"/><path d="m195 49 14 14-14 14-14-14Z" fill="#deefde"/></svg>\n';
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(name, bytes) {
  const kind = Buffer.from(name), output = Buffer.alloc(12 + bytes.length); output.writeUInt32BE(bytes.length); kind.copy(output, 4); bytes.copy(output, 8);
  let crc = 0xffffffff; for (const byte of Buffer.concat([kind, bytes])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + bytes.length); return output;
}
function pixel(x, y) {
  const rx = Math.max(64 - x, 0, x - 192), ry = Math.max(64 - y, 0, y - 192);
  if (x < 8 || y < 8 || x > 248 || y > 248 || rx * rx + ry * ry > 56 * 56) return [0, 0, 0, 0];
  const background = [16, 26, 32, 255];
  if (Math.abs(x - 195) + Math.abs(y - 63) <= 14) return [222, 239, 222, 255];
  const stem = x >= 80 && x <= 105 && y >= 67 && y <= 199;
  const bowl = (x >= 80 && x <= 132 && y >= 67 && y <= 151) || ((x - 132) ** 2 + (y - 109) ** 2 <= 42 ** 2);
  const hole = (x >= 105 && x <= 130 && y >= 89 && y <= 129) || ((x - 130) ** 2 + (y - 109) ** 2 <= 20 ** 2);
  return (stem || bowl) && !hole ? [190, 223, 206, 255] : background;
}
function png(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const color = pixel((x + (sx + .5) / 4) * 256 / size, (y + (sy + .5) / 4) * 256 / size);
      for (let c = 0; c < 4; c++) sum[c] += color[c];
    }
    for (let c = 0; c < 4; c++) raw[y * (1 + size * 4) + 1 + x * 4 + c] = Math.round(sum[c] / 16);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function buildIcon(destination = path.resolve(__dirname, '../assets')) {
  const images = SIZES.map(png), header = Buffer.alloc(6 + 16 * SIZES.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
  let offset = header.length;
  SIZES.forEach((size, i) => { const at = 6 + i * 16; header[at] = header[at + 1] = size === 256 ? 0 : size; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(images[i].length, at + 8); header.writeUInt32LE(offset, at + 12); offset += images[i].length; });
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'prateekAi.ico'), Buffer.concat([header, ...images]));
  fs.writeFileSync(path.join(destination, 'prateekAi.png'), images.at(-1));
  fs.writeFileSync(path.join(destination, 'prateekAi.svg'), svg);
}
if (require.main === module) { buildIcon(); console.log('Generated prateekAi icon (16–256px).'); }
module.exports = { buildIcon, SIZES };
