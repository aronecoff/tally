import { useRef, useState, type CSSProperties } from 'react'
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

// Chart annotation only. Past 7 columns a whole-dollar net no longer fits under
// its bars, so it is written compactly ($4.8K).
const COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})
function netLabel(net: number, compact: boolean): string {
  if (!compact) return money(net, { approx: true, sign: true })
  return `${net < 0 ? '−' : '+'}${COMPACT.format(Math.abs(net))}`
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
  if (months.length === 0) return null

  const max = Math.max(1, ...months.flatMap((p) => [p.income, p.spend]))
  const top = ceiling(max)
  const compact = months.length > 7
  const active = months.find((p) => p.m === (sel ?? focus))
  const anyFlagged = months.some((p) => p.partial || p.sparse)

  return (
    <div className="cfc" role="group" aria-label="Income and spending by month" ref={ref}>
      <div className="cfc-plot" style={{ '--plot-h': `${H}px` } as CSSProperties}>
        <span className="cfc-grid" aria-hidden="true">
          <span className="cfc-tick num">{money(top, { approx: true })}</span>
        </span>
        <span className="cfc-base" aria-hidden="true" />
        {months.map((p, i) => {
          const net = p.income - p.spend
          const inH = Math.max(2, (p.income / top) * H)
          const outH = Math.max(2, (p.spend / top) * H)
          const over = p.spend > p.income
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
                net >= 0 ? 'saved' : 'overspent'
              } ${money(Math.abs(net))}${p.partial ? ', so far' : p.sparse ? ', partial data' : ''}`}
              onClick={() => setSel(p.m)}
            >
              <span className="cfc-bars" aria-hidden="true">
                <span className="cfc-bar in" style={{ height: `${inH}px` }} />
                <span className={`cfc-bar out${over ? ' over' : ''}`} style={{ height: `${outH}px` }} />
              </span>
              <span className="cfc-x" aria-hidden="true">
                <span className="cfc-xmonth">{monthLabel(p.m).slice(0, 3)}</span>
                <span className={`cfc-xnet num ${net >= 0 ? 'pos' : 'over'}${flagged ? ' dim' : ''}`}>
                  {netLabel(net, compact)}
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
              {active.m !== focus && (
                <span className="cfc-cell">
                  <span className="cfc-cell-label">{active.income - active.spend >= 0 ? 'Saved' : 'Overspent'}</span>
                  <span className={`cfc-cell-fig num ${active.income - active.spend >= 0 ? 'pos' : 'over'}`}>
                    {money(Math.abs(active.income - active.spend))}
                  </span>
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="cfc-none">Tap a month to see its figures.</p>
        )}
      </div>
    </div>
  )
}
