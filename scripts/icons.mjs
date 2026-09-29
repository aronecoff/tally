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
// The mark is the app's name drawn literally: four strokes and the cross that
// closes a group of five. Brand palette only — Deep Ink field, Paper cream
// strokes, one Sage accent. No gradients, no glow: the old cyan→purple mark
// predated the rebrand and matched nothing in the app.
//
// 512 viewBox. `rounded` bakes the card corners (for favicon/PWA); full-bleed
// variants let the OS apply its own mask. `scale` shrinks the mark toward
// center for the maskable safe zone.
const INK = '#0C0414'
const PAPER = '#F4EFE4'
const SAGE = '#8FA083'

function svg({ rounded = true, scale = 1 } = {}) {
  const rx = rounded ? 116 : 0
  const s = 512
  const t = (256 * (1 - scale)).toFixed(1)
  // Four cream uprights, evenly spaced and centred on the canvas.
  const uprights = [184, 232, 280, 328]
    .map((x) => `<line x1="${x}" y1="165" x2="${x}" y2="347"/>`)
    .join('')
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- A barely-there lift so the field is not a flat black hole on a home
         screen. Below the threshold where it reads as a gradient. -->
    <radialGradient id="lift" cx="0.5" cy="0.32" r="0.9">
      <stop offset="0" stop-color="${PAPER}" stop-opacity="0.055"/>
      <stop offset="1" stop-color="${PAPER}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${s}" height="${s}" rx="${rx}" fill="${INK}"/>
  <rect width="${s}" height="${s}" rx="${rx}" fill="url(#lift)"/>
  <g transform="translate(${t} ${t}) scale(${scale})">
    <g stroke="${PAPER}" stroke-width="26" stroke-linecap="round">${uprights}</g>
    <!-- The fifth mark. Its ends stop ON the outer uprights: run it past them
         and the glyph reads as a "prohibited" slash instead of a tally. -->
    <line x1="184" y1="332" x2="328" y2="180" stroke="${SAGE}" stroke-width="26" stroke-linecap="round"/>
  </g>
</svg>
`
}

const render = (code, size) => sharp(Buffer.from(code), { density: 384 }).resize(size, size)

const rounded = svg({ rounded: true })
const fullBleed = svg({ rounded: false })
const maskable = svg({ rounded: false, scale: 0.82 })

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
