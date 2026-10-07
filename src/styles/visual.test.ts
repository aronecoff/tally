/**
 * Layout rules jsdom cannot apply (media queries, keyboard insets, touch
 * handling), pinned from the stylesheets' text. Each was verified in a real
 * browser at the widths named; these guard against the rule being dropped.
 */
import { describe, expect, it } from 'vitest'
import shellCss from './shell.css?raw'
import sheetCss from './sheet.css?raw'
import controlsCss from './controls.css?raw'
import budgetCss from './screens/budget.css?raw'
import accountsCss from './screens/accounts.css?raw'

interface Rule {
  sel: string
  /** Enclosing at-rules, outermost first ('@layer shell', '@media (min-width: 920px)'). */
  at: string[]
  decl: Record<string, string>
}

/** A flat list of style rules. Enough for these files: no braces or ';' inside values. */
function rules(css: string): Rule[] {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  const at: string[] = []
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') {
      const pre = buf.trim().replace(/\s+/g, ' ')
      buf = ''
      if (pre.startsWith('@')) {
        at.push(pre)
        continue
      }
      const end = s.indexOf('}', i)
      const decl: Record<string, string> = {}
      for (const d of s.slice(i + 1, end).split(';')) {
        const k = d.indexOf(':')
        if (k > 0) decl[d.slice(0, k).trim()] = d.slice(k + 1).trim().replace(/\s+/g, ' ')
      }
      out.push({ sel: pre, at: [...at], decl })
      i = end
    } else if (c === '}') {
      at.pop()
      buf = ''
    } else if (c === ';') buf = ''
    else buf += c
  }
  return out
}

/** The declarations for `sel` outside any @media (media null) or inside exactly `@media <media>`. */
function decls(css: string, sel: string, media: string | null = null): Record<string, string> {
  const hit = rules(css).filter(
    (r) =>
      r.sel.split(/\s*,\s*/).includes(sel) &&
      (media == null ? !r.at.some((a) => a.startsWith('@media')) : r.at.includes(`@media ${media}`)),
  )
  return Object.assign({}, ...hit.map((r) => r.decl))
}

const DESK = '(min-width: 920px)'
const WIDE = '(min-width: 1040px)'
const XS = '(max-width: 359px)'

describe('B71: a sheet clears the keyboard on wide screens too', () => {
  it('the desktop dialog sits above the keyboard and shrinks by it', () => {
    const backdrop = decls(sheetCss, '.sheet-backdrop[data-kb]', DESK)
    expect(backdrop['align-items']).toBe('flex-end')
    expect(backdrop['padding-bottom']).toMatch(/var\(--kb\)/)
    expect(decls(sheetCss, '.sheet-backdrop[data-kb] .sheet', DESK)['max-height']).toMatch(/var\(--kb\)/)
  })
})

describe('B72: pinch-zoom works on screens and sheets', () => {
  it('panes and sheet bodies allow pinch-zoom; the grab bar still takes raw drags', () => {
    expect(decls(shellCss, '.pane')['touch-action']).toBe('manipulation')
    expect(decls(sheetCss, '.sheet-body')['touch-action']).toBe('manipulation')
    expect(decls(sheetCss, '.sheet-drag')['touch-action']).toBe('none')
  })
})

describe('B105: the header at narrow widths', () => {
  it('the month arrows never shrink below 44pt', () => {
    expect(decls(shellCss, '.ms-step')).toMatchObject({ width: '44px', flex: 'none' })
  })

  it("'This month' hides wherever it no longer fits beside three header buttons", () => {
    expect(decls(shellCss, '.ms-today', '(max-width: 418px)').display).toBe('none')
  })

  it('at 320 the Categories title flows beside the back control instead of under Tell Tally', () => {
    expect(decls(shellCss, '.head-center', XS)).toMatchObject({ position: 'static', 'min-width': '0' })
    expect(decls(shellCss, '.ms-label', XS)['min-width']).toBe('5.5em')
    // Tell Tally stays in the header: it is the only way to it on a phone.
    expect(decls(shellCss, '.head-right', XS).display).toBeUndefined()
  })
})

describe('B108: a long category name stays inside its chip', () => {
  it('the chip is held to the row and its label ends in an ellipsis', () => {
    expect(decls(controlsCss, '.chip')['max-width']).toBe('100%')
    // Not on the chip itself: that clips with no ellipsis and cuts its hit slop.
    expect(decls(controlsCss, '.chip').overflow).toBeUndefined()
    expect(decls(controlsCss, '.chip-label')).toMatchObject({ 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis' })
  })
})

describe("B110: the wheel's link does not cover the first legend row", () => {
  it("the legend starts below the row's 4px hit slop", () => {
    expect(decls(budgetCss, '.wheel-key').margin).toBe('calc((var(--hit) - var(--ctl-md)) / 2) 0 0')
    expect(decls(budgetCss, '.wheel-go')['z-index']).toBeUndefined()
  })
})

describe('B69: a custom slice with no colour left is dotted, not hatched', () => {
  it('has its own legend swatch', () => {
    expect(decls(budgetCss, '.wheel-key-dot.is-dots').background).toMatch(/radial-gradient/)
  })
})

describe('B111: the desktop sidebar in a short or notched window', () => {
  it('scrolls, uses the dynamic viewport height and clears the safe areas', () => {
    const sidebar = decls(shellCss, '.sidebar', DESK)
    expect(sidebar['overflow-y']).toBe('auto')
    expect(sidebar.height).toBe('100%')
    expect(sidebar.padding).toMatch(/safe-area-inset-left/)
    const app = decls(shellCss, '.app', DESK)
    expect(app.height).toBe('100dvh')
    expect(app['grid-template-columns']).toMatch(/safe-area-inset-left/)
    expect(decls(shellCss, '.pane', DESK).padding).toMatch(/safe-area-inset-right/)
  })
})

describe('B112: the Budget drill-down', () => {
  it('a refund amount is the money-back colour (the screens layer beat .pos)', () => {
    expect(decls(budgetCss, '.bud-txn-amt.pos').color).toBe('var(--ok)')
  })

  it('at 320 the merchant takes its own line under the tag', () => {
    expect(decls(budgetCss, '.bud-txn-note > .bud-txn-name', XS)['flex-basis']).toBe('100%')
    expect(decls(budgetCss, '.bud-txn-note > .meta-sep:has(+ .bud-txn-name)', XS).display).toBe('none')
  })
})

describe('B113: Accounts rows at 320', () => {
  it('names wrap to two lines and the sub-line drops "Updated"', () => {
    expect(decls(accountsCss, '.acct-name', XS)).toMatchObject({ 'white-space': 'normal', '-webkit-line-clamp': '2' })
    expect(decls(accountsCss, '.acct-sub-verb', XS).display).toBe('none')
  })
})

describe('B114: the desktop header lines up with the screen below it', () => {
  const single = rules(shellCss).find((r) => r.at.includes(`@media ${DESK}`) && r.sel.includes(':has(') && r.sel.endsWith('> .app-head'))
  const wide = rules(shellCss).find((r) => r.at.includes(`@media ${WIDE}`) && r.sel.includes(':has(') && r.sel.endsWith('> .app-head'))

  it('starts at the pane padding, and at the centred column on single-column screens', () => {
    expect(decls(shellCss, '.app-head', DESK).padding).toMatch(/30px/)
    expect(single?.sel).toMatch(/\.activity/)
    expect(single?.sel).toMatch(/\.cats/)
    expect(single?.decl['padding-left']).toBe('max(30px, calc((100% - 660px) / 2))')
    // Accounts and the full Insights go two-column at 1040: back to the pane edge.
    expect(wide?.sel).toMatch(/\.analysis\.an-grid/)
    expect(wide?.decl['padding-left']).toBe('30px')
  })

  it('Home shows "Home" there, not a second Tally brand', () => {
    expect(decls(shellCss, '.head-brand-desk').display).toBe('none')
    expect(decls(shellCss, '.head-brand-desk', DESK).display).toBe('inline')
    expect(decls(shellCss, '.head-brand-mark', DESK).display).toBe('none')
  })
})
