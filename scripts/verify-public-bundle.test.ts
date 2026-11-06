// The gate, run as the build runs it, over a bundle made here. The private words live
// outside git, so these use a word of their own, and it must never reach the log.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, 'verify-public-bundle.mjs')
const PROJECT = resolve(__dirname, '../ios/Tally.xcodeproj/project.pbxproj')
const THEME = 'document.documentElement.dataset.theme="dark"'
const NAME = 'Quillmark'

let root: string
const dist = () => join(root, 'dist-public')
const terms = () => join(root, 'scripts/private-terms.local')

function run(): { code: number; output: string } {
  try {
    return { code: 0, output: execFileSync('node', [join(root, 'scripts/verify-public-bundle.mjs')], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    const failed = e as { status: number; stdout: string; stderr: string }
    return { code: failed.status, output: failed.stdout + failed.stderr }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-public-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(dist())
  copyFileSync(SCRIPT, join(root, 'scripts/verify-public-bundle.mjs'))
  const hash = createHash('sha256').update(THEME).digest('base64')
  writeFileSync(join(dist(), 'index.html'), `<meta http-equiv="Content-Security-Policy" content="script-src 'sha256-${hash}'" /><title>${NAME}</title><script>${THEME}</script>`)
  writeFileSync(join(dist(), 'instrument-serif-latin.woff2'), 'font')
  writeFileSync(join(dist(), 'app.js'), `const name = "${NAME}"`)
  writeFileSync(terms(), '# a comment\n/zanzibar/i\n')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the public bundle gate', () => {
  it('stamps a clean bundle', () => {
    expect(run()).toMatchObject({ code: 0 })
    expect(existsSync(join(dist(), '.verified'))).toBe(true)
  })

  it('writes the name the bundle was built with into the stamp', () => {
    run()
    expect(readFileSync(join(dist(), '.verified'), 'utf8').split('\n')[1]).toBe(NAME)
  })

  it('stops a bundle with no name to stamp', () => {
    writeFileSync(join(dist(), 'index.html'), readFileSync(join(dist(), 'index.html'), 'utf8').replace(/<title>.*<\/title>/, ''))
    const { code, output } = run()
    expect(code).toBe(1)
    expect(output).toContain('no title')
    expect(existsSync(join(dist(), '.verified'))).toBe(false)
  })

  it('stops a title edited by hand, which no script in the bundle agrees with', () => {
    writeFileSync(join(dist(), 'index.html'), readFileSync(join(dist(), 'index.html'), 'utf8').replace(NAME, 'Inkmark'))
    const { code, output } = run()
    expect(code).toBe(1)
    expect(output).toContain('no script in the bundle says Inkmark')
    expect(existsSync(join(dist(), '.verified'))).toBe(false)
  })

  it('stops a title that is only part of the name the code says', () => {
    writeFileSync(join(dist(), 'index.html'), readFileSync(join(dist(), 'index.html'), 'utf8').replace(NAME, 'Quill'))
    const { code, output } = run()
    expect(code).toBe(1)
    expect(output).toContain('no script in the bundle says Quill')
    expect(existsSync(join(dist(), '.verified'))).toBe(false)
  })

  it.each(['`', "'"])('takes the name between %s quotes as the minifier writes it', (quote) => {
    writeFileSync(join(dist(), 'app.js'), `var n=${quote}${NAME}${quote}`)
    expect(run()).toMatchObject({ code: 0 })
  })

  it('stops a bundle that still says the old name', () => {
    writeFileSync(join(dist(), 'app.js'), 'const name = "Plainsum"')
    const { code, output } = run()
    expect(code).toBe(1)
    expect(output).toContain('app.js: /\\bPlainsum\\b/')
    expect(existsSync(join(dist(), '.verified'))).toBe(false)
  })

  it('leaves the identifiers that keep that word on purpose', () => {
    writeFileSync(join(dist(), 'keys.js'), 'const f = "plainsum-backup", k = "plainsum:rentDating", u = "PlainsumNative", h = webkit.messageHandlers.plainsum')
    expect(run()).toMatchObject({ code: 0 })
  })

  it('finds a private word, and does not say which', () => {
    writeFileSync(join(dist(), 'app.js'), 'const who = "ZanzibarQuay"')
    const { code, output } = run()
    expect(code).toBe(1)
    expect(output).toContain('app.js: private term 1')
    expect(output.toLowerCase()).not.toContain('zanzibar')
    expect(existsSync(join(dist(), '.verified'))).toBe(false)
  })

  it.each([
    ['is missing', () => rmSync(terms()), 'is missing'],
    ['has only comments', () => writeFileSync(terms(), '# nothing yet\n\n'), 'has no words'],
    ['has a line that is not a regex', () => writeFileSync(terms(), '/zanzibar/i\nzanzibar\n'), 'line 2'],
    ['has a regex that will not compile', () => writeFileSync(terms(), '/zan(zibar/\n'), 'line 1'],
  ])('stops, and takes back an old stamp, when the list %s', (_, breakIt, says) => {
    expect(run().code).toBe(0)
    breakIt()
    const { code, output } = run()
    expect(code).toBe(1)
    expect(output).toContain(says)
    expect(existsSync(join(dist(), '.verified'))).toBe(false)
  })
})

describe('the Embed web bundle phase', () => {
  /** The script as Xcode runs it, out of the project file. */
  function phase(): string {
    const script = readFileSync(PROJECT, 'utf8').match(/name = "Embed web bundle";[\s\S]*?shellScript = "((?:[^"\\]|\\.)*)";/)?.[1]
    if (!script) throw new Error('no Embed web bundle phase')
    return script.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))
  }

  const web = () => join(root, 'out/App.app/Web')

  function embed(name: string): { code: number; output: string } {
    const env = { ...process.env, SRCROOT: join(root, 'ios'), TARGET_BUILD_DIR: join(root, 'out'), UNLOCALIZED_RESOURCES_FOLDER_PATH: 'App.app', PUBLIC_APP_NAME: name }
    try {
      return { code: 0, output: execFileSync('/bin/sh', ['-c', phase()], { encoding: 'utf8', stdio: 'pipe', env }) }
    } catch (e) {
      const failed = e as { status: number; stdout: string; stderr: string }
      return { code: failed.status, output: failed.stdout + failed.stderr }
    }
  }

  beforeEach(() => {
    mkdirSync(join(root, 'ios'))
    expect(run().code).toBe(0)
  })

  it('embeds a bundle stamped with the app’s name, and leaves the stamp behind', () => {
    expect(embed(NAME).code).toBe(0)
    expect(existsSync(join(web(), 'index.html'))).toBe(true)
    expect(existsSync(join(web(), '.verified'))).toBe(false)
  })

  it('takes a name with a space in it', () => {
    writeFileSync(join(dist(), 'index.html'), readFileSync(join(dist(), 'index.html'), 'utf8').replace(NAME, 'Quill Mark'))
    writeFileSync(join(dist(), 'app.js'), 'const name = "Quill Mark"')
    run()
    expect(embed('Quill Mark').code).toBe(0)
  })

  it('stops a bundle built under another name, and embeds nothing', () => {
    const { code, output } = embed('Inkmark')
    expect(code).toBe(1)
    expect(output).toContain(`built as "${NAME}"`)
    expect(output).toContain('"Inkmark"')
    expect(output).toContain('npm run build:public')
    expect(existsSync(web())).toBe(false)
  })

  it('stops a stamp from before the stamp held a name', () => {
    writeFileSync(join(dist(), '.verified'), `${'0'.repeat(64)}\n`)
    expect(embed(NAME).code).toBe(1)
    expect(existsSync(web())).toBe(false)
  })

  it('stops a bundle changed after the gate ran, and embeds nothing', () => {
    writeFileSync(join(dist(), 'app.js'), `${readFileSync(join(dist(), 'app.js'), 'utf8')};const old = "Plainsum"`)
    const { code, output } = embed(NAME)
    expect(code).toBe(1)
    expect(output).toContain('changed since it was verified')
    expect(output).toContain('npm run build:public')
    expect(existsSync(web())).toBe(false)
  })

  it('stops a file added after the gate ran', () => {
    writeFileSync(join(dist(), 'extra.js'), 'const old = 1')
    expect(embed(NAME).code).toBe(1)
    expect(existsSync(web())).toBe(false)
  })

  it('hashes folders and names with a space as the gate does', () => {
    mkdirSync(join(dist(), 'assets'))
    writeFileSync(join(dist(), 'assets/a b.js'), 'const a = 1')
    writeFileSync(join(dist(), 'assets-z.js'), 'const z = 1')
    run()
    expect(embed(NAME).code).toBe(0)
  })

  it('still stops a bundle with no stamp at all', () => {
    rmSync(join(dist(), '.verified'))
    const { code, output } = embed(NAME)
    expect(code).toBe(1)
    expect(output).toContain('missing or unverified')
  })
})
