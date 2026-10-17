// Generates the PWA icons (no image libraries): node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const out = new URL('../public/icons/', import.meta.url)
mkdirSync(out, { recursive: true })

const lerp = (a, b, t) => a + (b - a) * t
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t))
const BG1 = [20, 24, 35]
const BG2 = [9, 11, 16]
const RED = [255, 90, 92]
const ORANGE = [255, 138, 61]
const WHITE = [255, 255, 255]

/** Colour at (x,y) in unit coordinates [0,1]. `safe` shrinks the artwork for maskable icons. */
function shade(x, y, safe) {
  const s = safe ? 0.62 : 0.8 // artwork scale
  const dx = (x - 0.5) / s
  const dy = (y - 0.5) / s
  const r = Math.hypot(dx, dy)
  let c = mix(BG1, BG2, y)
  if (r < 0.46) {
    // gradient disc
    c = mix(RED, ORANGE, (dx + dy + 1) / 2)
    if (r > 0.36 && r < 0.4) c = mix(c, WHITE, 0.0) // keep ring solid colour
    if (r < 0.34) c = mix(c, [255, 255, 255], 0.0)
  }
  if (r < 0.34) {
    c = mix(BG1, BG2, 0.2)
    // clock hands: golden hour = 60 minutes, hand pointing to 12 and to 2 (a sliver of the hour)
    const hand = (len, ang, w) => {
      const px = Math.sin(ang), py = -Math.cos(ang)
      const t = Math.max(0, Math.min(len, dx * px + dy * py))
      return Math.hypot(dx - px * t, dy - py * t) < w
    }
    if (hand(0.26, 0, 0.032) || hand(0.19, (2 * Math.PI) / 3 / 1.5, 0.036)) c = WHITE
    if (r < 0.045) c = ORANGE
    // pulse mark at 12 o'clock
    if (Math.hypot(dx, dy + 0.27) < 0.04) c = RED
  }
  return c
}

function png(size, safe, round) {
  const rows = []
  const SS = 3
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4)
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size
          const y = (py + (sy + 0.5) / SS) / size
          // rounded-square silhouette for the "any" icon; maskable icons fill the whole canvas
          const q = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5))
          const inside = !round || (q < 0.5 - 0.22 ? true : Math.hypot(Math.max(Math.abs(x - 0.5) - 0.28, 0), Math.max(Math.abs(y - 0.5) - 0.28, 0)) < 0.22)
          if (!inside) continue
          const c = shade(x, y, safe)
          r += c[0]; g += c[1]; b += c[2]; a += 255
        }
      }
      const n = SS * SS
      const o = 1 + px * 4
      row[o] = a ? Math.round(r / (a / 255)) : 0
      row[o + 1] = a ? Math.round(g / (a / 255)) : 0
      row[o + 2] = a ? Math.round(b / (a / 255)) : 0
      row[o + 3] = Math.round(a / n)
    }
    rows.push(row)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const files = { 'icon-192.png': [192, false, true], 'icon-512.png': [512, false, true], 'maskable-512.png': [512, true, false], 'apple-touch-icon.png': [180, true, false] }
for (const [name, [size, safe, round]] of Object.entries(files)) {
  writeFileSync(new URL(name, out), png(size, safe, round))
  console.log('wrote', name)
}
