/**
 * B69: in the light theme Transport and Fun were almost the same colour on the
 * budget wheel (ΔE2000 2.5). Every pair of category colours in a theme must be
 * tellable apart: ΔE2000 of at least 10 (Other's grey is exempt; it is the
 * Uncategorized hatch, never a solid slice next to these).
 */
import { describe, expect, it } from 'vitest'
import tokens from './tokens.css?raw'

type Lab = [number, number, number]

function hexToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  // sRGB -> XYZ (D65), normalised to the white point.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

/** CIEDE2000 (Sharma, Wu and Dalal 2005). */
function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180
  const p7 = (c: number) => Math.sqrt(c ** 7 / (c ** 7 + 25 ** 7))
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const G = 0.5 * (1 - p7(Cb))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const hue = (a: number, b: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360)
  const h1p = hue(a1p, b1)
  const h2p = hue(a2p, b2)
  const both = C1p * C2p !== 0
  let dh = both ? h2p - h1p : 0
  if (dh > 180) dh -= 360
  else if (dh < -180) dh += 360
  const dL = L2 - L1
  const dC = C2p - C1p
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * rad) / 2)
  const Lb = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hb = h1p + h2p
  if (both) hb = (Math.abs(h1p - h2p) > 180 ? hb + (hb < 360 ? 360 : -360) : hb) / 2
  const T =
    1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2))
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(2 * dTheta * rad) * 2 * p7(Cbp)
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh))
}

/** The --cat-* colours of a theme's main block (the first block for that theme). */
function catColours(theme: 'dark' | 'light'): Map<string, string> {
  const block = tokens.match(new RegExp(`:root\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`))?.[1] ?? ''
  return new Map([...block.matchAll(/--cat-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]))
}

describe('category colours', () => {
  it('the colour distance is CIEDE2000 (published reference pairs)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3)
    expect(deltaE2000([50, 2.5, 0], [56, -27, -3])).toBeCloseTo(31.903, 2)
    expect(deltaE2000([50, -0.001, 2.49], [50, 0.0009, -2.49])).toBeCloseTo(4.8045, 3)
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`every pair is at least 10 ΔE2000 apart in the ${theme} theme`, () => {
      const cats = catColours(theme)
      expect(cats.size).toBe(9)
      const keys = [...cats.keys()].filter((k) => k !== 'other')
      const close: string[] = []
      for (let i = 0; i < keys.length; i++)
        for (let j = i + 1; j < keys.length; j++) {
          const d = deltaE2000(hexToLab(cats.get(keys[i])!), hexToLab(cats.get(keys[j])!))
          if (d < 10) close.push(`${keys[i]}/${keys[j]} ${d.toFixed(1)}`)
        }
      expect(close).toEqual([])
    })
  }
})
