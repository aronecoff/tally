import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/**
 * The two builds. Plain `npm run build` is personal: the owner's own app, as it has
 * always been. `npm run build:public` is Plainsum, the on-device App Store app.
 * The flavor comes from the environment and never from an .env file, so nothing
 * on disk can flip a build.
 */
export type Flavor = 'personal' | 'public'

export function readFlavor(): Flavor {
  const v = process.env.VITE_FLAVOR
  if (v === undefined || v === '' || v === 'personal') return 'personal'
  if (v === 'public') return 'public'
  throw new Error(`Unknown VITE_FLAVOR: ${v}`)
}

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** The public app's name. ios/PublicApp.xcconfig is the one place it is written. */
export function publicAppName(): string {
  const name = readFileSync(resolve(root, 'ios/PublicApp.xcconfig'), 'utf8').match(/^PUBLIC_APP_NAME\s*=\s*(\S.*?)\s*$/m)?.[1]
  if (!name) throw new Error('ios/PublicApp.xcconfig has no PUBLIC_APP_NAME')
  return name
}

/**
 * Real module -> public replacement. A swap replaces the module for every
 * importer, public modules included, so a replacement cannot reach the file it
 * replaces. A replacement must export what shared code imports, or the build
 * fails (src/flavor/public/conformance.ts catches signatures that drift).
 */
export const SWAPS: Record<string, string> = {
  'src/db/supabase.ts': 'src/flavor/public/supabase.ts',
  'src/db/seed.ts': 'src/flavor/public/seed.ts',
  'src/sync/sync.ts': 'src/flavor/public/sync.ts',
  'src/sync/merchantRules.ts': 'src/flavor/public/merchantRules.ts',
  'src/lib/ruleStore.ts': 'src/flavor/public/ruleStore.ts',
  'src/lib/bankTransport.ts': 'src/flavor/public/bankTransport.ts',
  'src/lib/backupPolicy.ts': 'src/flavor/public/backupPolicy.ts',
  'src/lib/native.ts': 'src/flavor/public/native.ts',
  'src/lib/brokerage.ts': 'src/flavor/public/brokerage.ts',
  'src/lib/merchantLinks.ts': 'src/flavor/public/merchantLinks.ts',
  'src/lib/brand.ts': 'src/flavor/public/brand.ts',
  'src/lib/prefs.ts': 'src/flavor/public/prefs.ts',
  'src/lib/swUpdate.ts': 'src/flavor/public/swUpdate.ts',
  'src/components/Account.tsx': 'src/flavor/public/Settings.tsx',
  'src/components/InstallBanner.tsx': 'src/flavor/public/InstallBanner.tsx',
  'src/components/BrokerageRow.tsx': 'src/flavor/public/BrokerageRow.tsx',
  'src/components/BrandGlyph.tsx': 'src/flavor/public/BrandGlyph.tsx',
  'src/flavor/slots.tsx': 'src/flavor/public/slots.tsx',
}

/** Reaching any of these from the public graph is a build error. */
const BANNED = [/^@supabase\//, /^virtual:pwa/]
const BANNED_FILES = ['src/lib/edgeError.ts']

const csp = (themeHash: string) =>
  [
    "default-src 'none'",
    `script-src 'self' 'sha256-${themeHash}'`,
    // React `style` attributes need 'unsafe-inline', the --grain token needs data:.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')

/** The public build's module swaps, and its index.html. */
export function publicFlavor(): Plugin[] {
  const swaps = new Map(Object.entries(SWAPS).map(([a, b]) => [resolve(root, a), resolve(root, b)]))
  const banned = new Set(BANNED_FILES.map((f) => resolve(root, f)))
  return [
    {
      name: 'plainsum-flavor',
      enforce: 'pre',
      // In a hook, not above: vite.config.ts calls publicFlavor() for its test
      // projects, and a personal build has no reason to read an iOS file.
      config: () => ({ define: { __PUBLIC_APP_NAME__: JSON.stringify(publicAppName()) } }),
      async resolveId(source, importer, options) {
        if (BANNED.some((re) => re.test(source))) this.error(`public flavor must not import ${source} (from ${importer})`)
        if (!importer) return null
        const hit = await this.resolve(source, importer, { ...options, skipSelf: true })
        if (!hit) return null
        const id = hit.id.split('?')[0]
        if (banned.has(id)) this.error(`public flavor must not reach ${id} (from ${importer})`)
        const to = swaps.get(id)
        return to ? { id: to } : hit
      },
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html
            .replace(/\s*<!-- Display face[\s\S]*?rel="stylesheet"\s*\/>/, '')
            .replace(/<title>.*<\/title>/, () => `<title>${publicAppName()}</title>`)
            .replace(/\s*<link rel="(icon|apple-touch-icon)"[^>]*>/g, '')
            .replace(/\s*<meta name="apple-mobile-web-app[^>]*>/g, '')
        },
      },
    },
    {
      name: 'plainsum-csp',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          // The dev client needs inline scripts and a websocket.
          if (ctx.server) return html
          const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
          if (inline.length !== 1) throw new Error(`expected one inline script (the theme boot), found ${inline.length}`)
          const hash = createHash('sha256').update(inline[0][1]).digest('base64')
          const meta = `<meta http-equiv="Content-Security-Policy" content="${csp(hash)}" />`
          return html.replace(/(<meta charset="UTF-8" \/>)/, `$1\n    ${meta}`)
        },
      },
    },
  ]
}
