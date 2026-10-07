// @vitest-environment jsdom
/**
 * B70: the cash-flow chart's month nets ran together on narrow screens and on
 * long histories, a compact net under $1K read '−$560.5', and at 320px each
 * month was a 41px tap target. The chart now shows only as many months as fit
 * 44px columns (the screen's month always among them) and picks whole or
 * compact nets by the column width. Values are invented.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CashflowChart, type MonthPoint } from './CashflowChart'

/** n finished months ending 2026-09, each netting `net`. */
function months(n: number, net = 1200): MonthPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(2026, 8 - (n - 1 - i), 1)
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return { m, income: 5000 + net, spend: 5000 }
  })
}

/** jsdom has no layout: give the plot a width. */
function withPlotWidth(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('cfc-plot') ? px : 0
    },
  })
  // jsdom defines clientWidth on Element.prototype: dropping the override restores it.
  return () => {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  }
}

let restore: (() => void) | null = null
afterEach(() => {
  cleanup()
  restore?.()
  restore = null
})

const cols = (root: HTMLElement) => [...root.querySelectorAll('.cfc-col')]
const nets = (root: HTMLElement) => cols(root).map((c) => c.querySelector('.cfc-xnet')?.textContent ?? '')

describe('compact nets', () => {
  it('a net under $1K is whole dollars, a larger one a short K figure', () => {
    const data = months(8)
    data[0] = { ...data[0], income: 1000, spend: 1560.5 }
    data[1] = { ...data[1], income: 6750, spend: 2000 }
    data[2] = { ...data[2], income: 14345, spend: 2000 }
    data[3] = { ...data[3], income: 3000, spend: 2000 }
    const { container } = render(<CashflowChart months={data} focus={data[7].m} />)
    // No width known (a hidden pane): every month, compact past seven.
    expect(nets(container).slice(0, 4)).toEqual(['−$561', '+$4.8K', '+$12K', '+$1K'])
  })
})

describe('columns that fit', () => {
  it('at 320 wide (a 288px plot) shows six 48px months, the latest last', () => {
    restore = withPlotWidth(288)
    const data = months(14)
    const { container } = render(<CashflowChart months={data} focus={data[13].m} />)
    expect(cols(container)).toHaveLength(6)
    expect(cols(container).at(-1)?.getAttribute('aria-label')).toMatch(/^September 2026/)
    // 48px columns cannot hold '+$1,200' with room to spare: compact.
    expect(nets(container)[0]).toBe('+$1.2K')
  })

  it('keeps the month on screen in view when it is older than the window', () => {
    restore = withPlotWidth(288)
    const data = months(14)
    const { container } = render(<CashflowChart months={data} focus={data[3].m} />)
    const labels = cols(container).map((c) => c.getAttribute('aria-label') ?? '')
    expect(labels).toHaveLength(6)
    expect(labels.some((l) => l.startsWith('November 2025'))).toBe(true)
    expect(container.querySelector('.cfc-col.sel')?.getAttribute('aria-label')).toMatch(/^November 2025/)
  })

  it("on a 440 phone (a 408px plot) seven months keep whole-dollar nets", () => {
    restore = withPlotWidth(408)
    const data = months(7)
    const { container } = render(<CashflowChart months={data} focus={data[6].m} />)
    expect(cols(container)).toHaveLength(7)
    expect(nets(container)[0]).toBe('+$1,200')
  })

  it('a wide plot shows the whole history', () => {
    restore = withPlotWidth(660)
    const data = months(14)
    const { container } = render(<CashflowChart months={data} focus={data[13].m} />)
    expect(cols(container)).toHaveLength(14)
  })
})

describe('the live month before payday', () => {
  // It has only spent so far: not 'over' its income, in red, any more than
  // the screen's hero says 'Overspent' (lib/payday.ts).
  const data = (): MonthPoint[] => [
    ...months(3),
    { m: '2026-10', income: 12.4, spend: 2450, partial: true, awaitingPay: true },
  ]

  it('draws its spending bar and its net without the over mark', () => {
    restore = withPlotWidth(600)
    const { container } = render(<CashflowChart months={data()} focus="2026-10" />)
    const live = cols(container).at(-1)!
    expect(live.querySelector('.cfc-bar.out.over')).toBeNull()
    expect(live.querySelector('.cfc-xnet')?.classList.contains('over')).toBe(false)
    expect(live.getAttribute('aria-label')).not.toContain('overspent')
    expect(live.getAttribute('aria-label')).toContain('before payday')
  })

  it('tapped from another month, its readout is not a red Overspent', () => {
    restore = withPlotWidth(600)
    const { container } = render(<CashflowChart months={data()} focus="2026-09" />)
    fireEvent.click(cols(container).at(-1)!)
    expect(container.querySelector('.cfc-readout-month')?.textContent).toBe('October 2026')
    const cells = [...container.querySelectorAll('.cfc-cell')].map((c) => c.querySelector('.cfc-cell-label')?.textContent)
    expect(cells).not.toContain('Overspent')
    expect(container.querySelector('.cfc-readout .cfc-cell-fig.over')).toBeNull()
  })

  it('once pay lands, a month that spent more than it took in is over again (control)', () => {
    restore = withPlotWidth(600)
    const { container } = render(<CashflowChart months={[...months(3), { m: '2026-10', income: 1000, spend: 2450, partial: true }]} focus="2026-10" />)
    expect(cols(container).at(-1)!.querySelector('.cfc-bar.out.over')).not.toBeNull()
  })
})
