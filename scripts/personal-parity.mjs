// Proves the personal build still matches main. Personal output cannot stay
// byte-identical once code moves between modules, so this compares what shapes
// behaviour. It builds the merge base and this tree with the same sentinel
// environment, in temp dirs, and compares:
//   - the file list, hashes aside
//   - index.html, hashes aside
//   - the CSS, byte for byte
//   - the set of string literals in the JS
// Expected result: zero difference.
//
//   node scripts/personal-parity.mjs [ref]     ref defaults to the merge base with main
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const ref = process.argv[2] ?? git('merge-base', 'HEAD', 'main')
const tmp = mkdtempSync(join(tmpdir(), 'personal-parity-'))
const vite = join(root, 'node_modules/.bin/vite')

// Process env beats .env files, so both builds see the same values.
const env = {
  ...process.env,
  VITE_FLAVOR: '',
  VITE_SUPABASE_URL: 'https://parity-sentinel.invalid',
  VITE_SUPABASE_ANON_KEY: 'parity-sentinel-key',
}

function build(cwd, outDir) {
  execFileSync(vite, ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], { cwd, env, stdio: 'inherit' })
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
}

/** Content hashes out of a file name: assets/index-AbC123_x.js -> assets/index-#.js. */
const unhash = (s) => s.replace(/(assets\/[\w.]+?)-[\w-]{8}\.(js|css)/g, '$1-#.$2').replace(/(workbox)-[0-9a-f]{8}\.js/g, '$1-#.js')

function literals(dir, names) {
  const out = new Set()
  const visit = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(visit)
    if (n.type === 'Literal' && typeof n.value === 'string') out.add(n.value)
    if (n.type === 'TemplateElement') out.add(n.value.cooked)
    for (const k in n) if (k !== 'type' && k !== 'start' && k !== 'end') visit(n[k])
  }
  for (const f of names) visit(parse(readFileSync(join(dir, f), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }))
  return out
}

function read(dir) {
  const files = walk(dir).map((f) => relative(dir, f)).sort()
  const assets = files.filter((f) => f.startsWith('assets/'))
  const sum = (f) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
  return {
    files: files.map(unhash),
    html: unhash(readFileSync(join(dir, 'index.html'), 'utf8')),
    css: assets.filter((f) => f.endsWith('.css')).map(sum),
    strings: literals(dir, assets.filter((f) => f.endsWith('.js'))),
  }
}

const only = (a, b) => [...a].filter((x) => !b.has(x))
let bad = 0
const report = (ok, label, detail = []) => {
  console.log(`${ok ? 'same' : 'DIFF'}  ${label}`)
  if (!ok) {
    bad++
    for (const d of detail.slice(0, 40)) console.log(`      ${JSON.stringify(d)}`)
  }
}

try {
  const base = join(tmp, 'base')
  execFileSync('/bin/sh', ['-c', `mkdir -p "${base}" && git archive ${ref} | tar -x -C "${base}"`], { cwd: root })
  symlinkSync(join(root, 'node_modules'), join(base, 'node_modules'))
  build(base, join(tmp, 'out-base'))
  build(root, join(tmp, 'out-head'))
  const a = read(join(tmp, 'out-base'))
  const b = read(join(tmp, 'out-head'))

  console.log(`personal parity against ${ref.slice(0, 7)}`)
  const fa = new Set(a.files)
  const fb = new Set(b.files)
  report(a.files.join() === b.files.join(), `file list (${b.files.length})`, [...only(fa, fb).map((x) => `-${x}`), ...only(fb, fa).map((x) => `+${x}`)])
  report(a.html === b.html, 'index.html')
  report(a.css.join() === b.css.join(), `CSS (${b.css.length})`)
  const gone = only(a.strings, b.strings)
  const added = only(b.strings, a.strings)
  report(!gone.length && !added.length, `string literals (${a.strings.size} and ${b.strings.size})`, [
    ...gone.map((x) => `-${x}`),
    ...added.map((x) => `+${x}`),
  ])
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(bad ? 1 : 0)
