import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { money } from '../lib/format'
import { monthLabel } from '../lib/dates'
import { useSettle } from '../lib/motion'

export interface MonthPoint {
  m: string // YYYY-MM
  income: number
  spend: number
  /** Still in progress — its bars are not comparable to a finished month. */
  partial?: boolean
  /** Too few transactions to be a real record of the month. */
  sparse?: boolean
  /** The live month before payday (lib/payday.ts): it has only spent so far,
   *  so its spending is not 'over' its income, as no hero calls it Overspent. */
  awaitingPay?: boolean
}

interface Props {
  months: MonthPoint[]
  /** The month the screen is showing: the readout describes it until a column is tapped. */
  focus: string
}

const H = 132 // plot height in px

/** A round ceiling for the scale: the next fifth of the leading power of ten. */
function ceiling(max: number): number {
  const mag = 10 ** Math.floor(Math.log10(max))
  const step = mag / 5
  return Math.ceil(max / step) * step
}

/** Narrowest column: a 44pt tap target. Past that many months, the oldest go. */
const MIN_COL = 44
/** A month's net under its bars: whole dollars ('+$1,234', about 43px wide at
 *  most for four digits) where the column holds it with 6px to spare. */
const FULL_NET_W = 43

/** Which net labels a column shows: whole dollars, compact, or only the selected month's. */
type NetMode = 'full' | 'compact' | 'sel'

// Chart annotation only: a net that does not fit whole is written compactly.
// Under $1K that is whole dollars ('−$561', never '−$560.5'); from $1K a short
// K figure, written by hand so every engine prints the same ('+$4.8K', '+$12K').
function netLabel(net: number, compact: boolean): string {
  if (!compact || Math.abs(net) < 1000) return money(net, { approx: true, sign: true })
  const k = Math.abs(net) / 1000
  const s = (k < 9.95 ? k.toFixed(1) : Math.round(k).toString()).replace(/\.0$/, '')
  return `${net < 0 ? '−' : '+'}$${s}K`
}

/**
 * Income and spending, month by month, with each month's net written once,
 * under its own bars.
 *
 * The readout describes the month on screen until a column is tapped; a tap is
 * sticky. Months the data cannot support (the in-progress one, and any with
 * implausibly few transactions) are hatched and flagged rather than quietly
 * plotted: a half-empty month drawn as a short bar reads as "a frugal month"
 * when it actually means "we don't have the data".
 */
export function CashflowChart({ months, focus }: Props) {
  const [sel, setSel] = useState<string | null>(null)
  // The readout settles when the month it describes changes (a column tap).
  const ref = useRef<HTMLDivElement>(null)
  useSettle(ref, '.cfc-readout', sel ?? focus)

  // The plot's width in px, measured before paint. A hidden pane measures 0:
  // keep the last width (0 = not known yet: every month, the old count rule).
  const plotRef = useRef<HTMLDivElement>(null)
  const [plotW, setPlotW] = useState(0)
  const hasPlot = months.length > 0
  useLayoutEffect(() => {
    const el = plotRef.current
    if (!el) return
    const w0 = Math.round(el.clientWidth)
    if (w0 > 0) setPlotW(w0)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width)
      if (w > 0) setPlotW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasPlot])

  // As many months as fit 44pt columns (at least six), the latest last; the
  // month on screen is always among them.
  const n = plotW > 0 ? Math.min(months.length, Math.max(6, Math.floor(plotW / MIN_COL))) : months.length
  const fi = months.findIndex((p) => p.m === focus)
  const end = fi >= 0 && fi < months.length - n ? Math.max(fi + 1, n) : months.length
  const shown = months.slice(end - n, end)
  // Whole-dollar nets where a column holds one; else compact. If a label is
  // still wider than its column once drawn (a 5-digit net, another font), the
  // next step: compact, then only the selected month's net.
  const guess: NetMode = plotW > 0 ? (plotW / Math.max(1, n) - 6 >= FULL_NET_W ? 'full' : 'compact') : months.length > 7 ? 'compact' : 'full'
  const sig = `${plotW}|${shown.map((p) => `${p.m}:${p.income - p.spend}`).join(',')}`
  const [bump, setBump] = useState<{ sig: string; mode: NetMode } | null>(null)
  const mode: NetMode = bump?.sig === sig ? bump.mode : guess
  useLayoutEffect(() => {
    const plot = plotRef.current
    if (!plot || plotW <= 0 || mode === 'sel') return
    const tooWide = [...plot.querySelectorAll<HTMLElement>('.cfc-col')].some((col) => {
      const net = col.querySelector<HTMLElement>('.cfc-xnet')
      return !!net && col.clientWidth > 0 && net.getBoundingClientRect().width > col.clientWidth - 6 + 0.5
    })
    if (tooWide) setBump({ sig, mode: mode === 'full' ? 'compact' : 'sel' })
  }, [sig, mode, plotW])

  if (!hasPlot) return null

  const max = Math.max(1, ...shown.flatMap((p) => [p.income, p.spend]))
  const top = ceiling(max)
  const compact = mode !== 'full'
  const active = months.find((p) => p.m === (sel ?? focus))
  const anyFlagged = shown.some((p) => p.partial || p.sparse)

  return (
    <div className="cfc" role="group" aria-label="Income and spending by month" ref={ref}>
      <div className="cfc-plot" ref={plotRef} style={{ '--plot-h': `${H}px` } as CSSProperties}>
        <span className="cfc-grid" aria-hidden="true">
          <span className="cfc-tick num">{money(top, { approx: true })}</span>
        </span>
        <span className="cfc-base" aria-hidden="true" />
        {shown.map((p, i) => {
          const net = p.income - p.spend
          const inH = Math.max(2, (p.income / top) * H)
          const outH = Math.max(2, (p.spend / top) * H)
          const waiting = !!p.awaitingPay
          const over = p.spend > p.income && !waiting
          const isSel = p.m === active?.m
          const flagged = p.partial || p.sparse
          return (
            <button
              key={p.m}
              type="button"
              className={`cfc-col${isSel ? ' sel' : ''}${flagged ? ' flagged' : ''}`}
              style={{ '--i': i } as CSSProperties}
              aria-pressed={isSel}
              aria-label={`${monthLabel(p.m)}: income ${money(p.income)}, spending ${money(p.spend)}, ${
                waiting ? 'before payday, net' : net >= 0 ? 'saved' : 'overspent'
              } ${waiting ? money(net) : money(Math.abs(net))}${p.partial ? ', so far' : p.sparse ? ', partial data' : ''}`}
              onClick={() => setSel(p.m)}
            >
              <span className="cfc-bars" aria-hidden="true">
                <span className="cfc-bar in" style={{ height: `${inH}px` }} />
                <span className={`cfc-bar out${over ? ' over' : ''}`} style={{ height: `${outH}px` }} />
              </span>
              <span className="cfc-x" aria-hidden="true">
                <span className="cfc-xmonth">{monthLabel(p.m).slice(0, 3)}</span>
                <span className={`cfc-xnet num ${waiting ? '' : net >= 0 ? 'pos' : 'over'}${flagged ? ' dim' : ''}`}>
                  {mode !== 'sel' || isSel ? netLabel(net, compact) : null}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="cfc-legend" aria-hidden="true">
        <span>
          <i className="cfc-dot in" />
          Income
        </span>
        <span>
          <i className="cfc-dot out" />
          Spending
        </span>
        {anyFlagged && (
          <span>
            <i className="cfc-dot hatch" />
            Incomplete
          </span>
        )}
      </div>

      <div className="cfc-readout" aria-live="polite">
        {active ? (
          <>
            <div className="cfc-readout-head">
              <span className="cfc-readout-month">{monthLabel(active.m)}</span>
              {active.partial && <span className="cfc-flag">So far</span>}
              {active.sparse && <span className="cfc-flag">Partial data</span>}
            </div>
            <div className="cfc-cells">
              <span className="cfc-cell">
                <span className="cfc-cell-label">Income</span>
                <span className="cfc-cell-fig num">{money(active.income)}</span>
              </span>
              <span className="cfc-cell">
                <span className="cfc-cell-label">Spending</span>
                <span className="cfc-cell-fig num">{money(active.spend)}</span>
              </span>
              {/* The screen's hero already states the viewed month's net. */}
              {active.m !== focus &&
                (active.awaitingPay ? (
                  <span className="cfc-cell">
                    <span className="cfc-cell-label">No pay yet</span>
                    <span className="cfc-cell-fig num">{money(active.income - active.spend)}</span>
                  </span>
                ) : (
                  <span className="cfc-cell">
                    <span className="cfc-cell-label">{active.income - active.spend >= 0 ? 'Saved' : 'Overspent'}</span>
                    <span className={`cfc-cell-fig num ${active.income - active.spend >= 0 ? 'pos' : 'over'}`}>
                      {money(Math.abs(active.income - active.spend))}
                    </span>
                  </span>
                ))}
            </div>
          </>
        ) : (
          <p className="cfc-none">Tap a month to see its figures.</p>
        )}
      </div>
    </div>
  )
}
