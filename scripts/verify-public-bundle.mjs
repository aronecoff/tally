// The public bundle's gate. Runs at the end of `npm run build:public`, over every
// file in dist-public, and exits 1 on any hit. On success it stamps
// dist-public/.verified with the bundle's hash and, on the second line, the name the
// bundle was built with. Xcode refuses a bundle without the stamp, one stamped with
// any name but PUBLIC_APP_NAME, and one that no longer hashes to its stamp, so a rename
// cannot ship over an old bundle and nothing added after this gate can ship at all.
//
// Not gated, measured false positives: `sentinel` (React's memo cache),
// `password` (React's input-type table) and `localhost` (Dexie's debug check).
//
// This repo is public, so the personal words it checks for are not written here. They
// live in scripts/private-terms.local, which git ignores: one regex a line, like
// /word/i, with # for a comment. A checkout without that file cannot pass this gate.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const dist = join(root, 'dist-public')
const TERMS = join(root, 'scripts/private-terms.local')
const STAMP = '.verified'

/** Stops the gate, leaving no stamp behind from an earlier run. */
function stop(message) {
  rmSync(join(dist, STAMP), { force: true })
  console.error(`verify-public-bundle: ${message}`)
  process.exit(1)
}

if (!existsSync(join(dist, 'index.html'))) stop('dist-public/index.html is missing')

const FORBIDDEN = [
  // The cloud and the connectors
  /supabase/i, /snaptrade/i, /\bteller\b/i, /merchant_rules/i, /functions\/v1/i, /OWNER_EMAIL/i,
  /auth\.getSession/, /signInWith/,
  // Who wrote it, as far as the repo's own address says. The rest is in TERMS.
  /aronecoff/i,
  // Hosts and the PWA layer
  /github\.io/i, /fonts\.googleapis/i, /fonts\.gstatic/i, /s2\/favicons/i, /google\.com\/search/i, /workbox/i,
  /serviceWorker\.register/i,
  // Copy that belongs to the personal app
  /\bTally\b/, /Sign in/,
  // The public app's old name. The identifiers that keep it are not written this way:
  // plainsum-backup, plainsum:, PlainsumNative.
  /\bPlainsum\b/,
]

/** Every http(s) URL in the bundle must start with one of these. */
const URLS = ['bridge.simplefin.org', 'www.w3.org', 'react.dev/errors', 'tinyurl.com/y2uuvskb', 'bit.ly/2kdckMn']

const NOT_SHIPPED = [/(^|\/)sw\.js$/, /(^|\/)registerSW\.js$/, /(^|\/)manifest\.webmanifest$/, /\.map$/]

/** The words of TERMS. No list, or one that says nothing, checks nothing, so it stops
 *  the gate. A line it cannot read would be a word left unchecked, so that does too. */
function privateTerms() {
  if (!existsSync(TERMS)) stop('scripts/private-terms.local is missing. Copy it from your other checkout: it holds the personal words this bundle must not contain, and git does not carry it.')
  const terms = []
  for (const [i, raw] of readFileSync(TERMS, 'utf8').split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^\/(.+)\/([a-z]*)$/)
    if (!m) stop(`scripts/private-terms.local line ${i + 1} is not a /regex/`)
    try {
      terms.push(new RegExp(m[1], m[2]))
    } catch {
      stop(`scripts/private-terms.local line ${i + 1} is not a /regex/`)
    }
  }
  if (!terms.length) stop('scripts/private-terms.local has no words in it')
  return terms
}

/** .env.local's values, read at run time so they are never committed: the URL,
 *  its first host label (the project ref) and the key. */
function envSecrets() {
  const file = join(root, '.env.local')
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*[A-Z0-9_]+\s*=\s*["']?([^"'\s]+)/)
    if (!m || m[1].length < 8) continue
    out.push(m[1])
    try {
      out.push(new URL(m[1]).hostname.split('.')[0])
    } catch {
      /* not a URL */
    }
  }
  return out
}

/** Whether a script holds this string on its own, in any of the quotes a minifier uses. */
const saysWhole = (text, string) => ['"', "'", '`'].some((quote) => text.includes(`${quote}${string}${quote}`))

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
}

// Earned again on every run: a bundle that fails here must not keep an old stamp.
rmSync(join(dist, STAMP), { force: true })

const files = walk(dist)
  .filter((f) => relative(dist, f) !== STAMP)
  .sort()
const secrets = envSecrets()
const terms = privateTerms()
const hits = []

for (const file of files) {
  const name = relative(dist, file)
  if (NOT_SHIPPED.some((re) => re.test(name))) hits.push(`${name}: must not ship`)
  const text = readFileSync(file, 'latin1')
  for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${name}: ${re}`)
  // Never print a word from TERMS, or a value from .env.local: logs get pasted.
  terms.forEach((re, i) => {
    if (re.test(text)) hits.push(`${name}: private term ${i + 1}`)
  })
  secrets.forEach((s, i) => {
    if (text.includes(s)) hits.push(`${name}: .env.local value ${i + 1}`)
  })
  for (const [url] of text.matchAll(/https?:\/\/[^\s"'`<>)\\]*/g)) {
    const rest = url.replace(/^https?:\/\//, '')
    if (!URLS.some((ok) => rest.startsWith(ok))) hits.push(`${name}: URL not on the list: ${url}`)
  }
}

// The CSP hash must be the hash of the theme script as it ended up on disk.
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1]
if (!csp) hits.push('index.html: no Content-Security-Policy')
else if (inline.length !== 1) hits.push(`index.html: ${inline.length} inline scripts`)
else if (!csp.includes(`'sha256-${createHash('sha256').update(inline[0][1]).digest('base64')}'`)) {
  hits.push('index.html: the CSP hash is not the hash of the theme script')
}

// The name went in at build time, from the same place as every visible string.
const name = html.match(/<title>([^<]+)<\/title>/)?.[1]
if (!name) hits.push('index.html: no title, so no name to stamp')
// A title can be edited by hand. The code that says the name cannot, so it has to agree,
// as a whole string: a title that is only part of the name is not the name.
else if (!files.some((f) => f.endsWith('.js') && saysWhole(readFileSync(f, 'latin1'), name))) hits.push(`no script in the bundle says ${name}, the name in its title`)

// The display face ships inside the app: a build without it would fall back to
// Georgia on every hero figure, with nothing else to say so.
if (!files.some((f) => /instrument-serif.*\.woff2$/.test(f))) hits.push('the display font is not in the bundle')

if (hits.length) {
  console.error(`verify-public-bundle: ${hits.length} problem${hits.length === 1 ? '' : 's'}`)
  for (const h of [...new Set(hits)]) console.error(`  ${h}`)
  process.exit(1)
}

// The Embed web bundle phase works this out again, in shell, from the same files in the
// same order. Change one and change the other.
const sum = createHash('sha256')
for (const file of files) sum.update(relative(dist, file)).update(readFileSync(file))
writeFileSync(join(dist, STAMP), `${sum.digest('hex')}\n${name}\n`)
console.log(`verify-public-bundle: ${files.length} files clean`)
