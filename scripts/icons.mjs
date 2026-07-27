// Generates every Tally logo asset from one parameterized SVG design.
// Run `node scripts/icons.mjs` after changing the design below, then commit
// the regenerated files. Outputs:
//   public/icon.svg                 — canonical mark (favicon / source of truth)
//   public/pwa-192.png, pwa-512.png — manifest icons (rounded corners, alpha)
//   public/maskable-512.png         — manifest maskable (full-bleed, safe zone)
//   public/apple-touch-icon.png     — 180px, full-bleed opaque (iOS masks it)
//   ios/Tally/Assets.xcassets/AppIcon.appiconset/icon-1024.png
//                                   — full-bleed opaque (Xcode requires no alpha)
import { writeFileSync } from 'node:fs'
import sharp from 'sharp'

// ---- The design, one place ---------------------------------------------------
// 512 viewBox. `rounded` bakes the card corners + rim (for favicon/PWA);
// full-bleed variants let the OS apply its own mask. `scale` shrinks the mark
// toward center (maskable safe zone).
function svg({ rounded = true, scale = 1 } = {}) {
  const rx = rounded ? 116 : 0
  const s = 512
  const t = (256 * (1 - scale)).toFixed(1)
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.34" r="0.95">
      <stop offset="0" stop-color="#161629"/>
      <stop offset="1" stop-color="#07070e"/>
    </radialGradient>
    <linearGradient id="t" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3ce8ff"/>
      <stop offset="0.45" stop-color="#6d7cff"/>
      <stop offset="1" stop-color="#b34dff"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.5"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glowWide" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="24"/>
    </filter>
    <filter id="glowTight" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
  </defs>
  <rect width="${s}" height="${s}" rx="${rx}" fill="url(#bg)"/>
  <g transform="translate(${t} ${t}) scale(${scale})">
    <g filter="url(#glowWide)" opacity="0.4">
      <rect x="142" y="146" width="228" height="58" rx="29" fill="url(#t)"/>
      <rect x="227" y="146" width="58" height="242" rx="29" fill="url(#t)"/>
    </g>
    <g filter="url(#glowTight)" opacity="0.55">
      <rect x="142" y="146" width="228" height="58" rx="29" fill="url(#t)"/>
      <rect x="227" y="146" width="58" height="242" rx="29" fill="url(#t)"/>
    </g>
    <g fill="url(#t)">
      <rect x="142" y="146" width="228" height="58" rx="29"/>
      <rect x="227" y="146" width="58" height="242" rx="29"/>
    </g>
    <g fill="url(#sheen)" opacity="0.2">
      <rect x="142" y="146" width="228" height="58" rx="29"/>
      <rect x="227" y="146" width="58" height="242" rx="29"/>
    </g>
  </g>${rounded ? `
  <rect x="2" y="2" width="${s - 4}" height="${s - 4}" rx="${rx - 2}" fill="none" stroke="url(#t)" stroke-width="2.5" opacity="0.25"/>` : ''}
</svg>
`
}

const render = (code, size) => sharp(Buffer.from(code), { density: 300 }).resize(size, size)

const rounded = svg({ rounded: true })
const fullBleed = svg({ rounded: false })
const maskable = svg({ rounded: false, scale: 0.92 })

writeFileSync('public/icon.svg', rounded)
await render(rounded, 192).png().toFile('public/pwa-192.png')
await render(rounded, 512).png().toFile('public/pwa-512.png')
await render(maskable, 512).png().toFile('public/maskable-512.png')
await render(fullBleed, 180).removeAlpha().png().toFile('public/apple-touch-icon.png')
await render(fullBleed, 1024)
  .removeAlpha()
  .png()
  .toFile('ios/Tally/Assets.xcassets/AppIcon.appiconset/icon-1024.png')

console.log('icons regenerated')
