import { useState } from 'react'
import { money } from '../lib/format'
import { monthLabel } from '../lib/dates'

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
}

const H = 132 // plot height in px

/**
 * Money in vs money out, month by month, with the kept/overspent delta.
 *
 * Tapping a month pins its detail below. Months the data cannot support —
 * the in-progress one, and any with implausibly few transactions — are drawn
 * hatched and labelled rather than quietly plotted, because a half-empty month
 * rendered as a short bar reads as "a frugal month" when it actually means
 * "we don't have the data".
 */
export function CashflowChart({ months }: Props) {
  const [sel, setSel] = useState<string | null>(null)
  if (months.length === 0) return null

  const max = Math.max(1, ...months.flatMap((p) => [p.income, p.spend]))
  const active = months.find((p) => p.m === sel) ?? months[months.length - 1]
  const saved = active.income - active.spend
  const rate = active.income > 0 ? (saved / active.income) * 100 : null

  return (
    <div className="cfc">
      <div className="cfc-plot" style={{ height: `${H}px` }}>
        {months.map((p) => {
          const inH = Math.max(2, (p.income / max) * H)
          const outH = Math.max(2, (p.spend / max) * H)
          const over = p.spend > p.income
          const isSel = p.m === active.m
          const flagged = p.partial || p.sparse
          return (
            <button
              key={p.m}
              className={`cfc-col ${isSel ? 'sel' : ''} ${flagged ? 'flagged' : ''}`}
              onClick={() => setSel(p.m === sel ? null : p.m)}
              title={`${monthLabel(p.m)} — in ${money(p.income)}, out ${money(p.spend)}`}
            >
              <span className="cfc-bars">
                <span className="cfc-bar in" style={{ height: `${inH}px` }} />
                <span className={`cfc-bar out ${over ? 'over' : ''}`} style={{ height: `${outH}px` }} />
              </span>
              <span className="cfc-xlabel">{monthLabel(p.m).slice(0, 3)}</span>
            </button>
          )
        })}
      </div>

      <div className="cfc-legend">
        <span><i className="cfc-dot in" /> in</span>
        <span><i className="cfc-dot out" /> out</span>
        <span className="cfc-hint">tap a month</span>
      </div>

      <div className="cfc-detail">
        <div className="cfc-detail-head">
          <strong>{monthLabel(active.m)}</strong>
          {active.partial && <span className="cfc-flag">in progress</span>}
          {active.sparse && <span className="cfc-flag warn">incomplete data</span>}
        </div>
        <div className="cfc-detail-grid">
          <span><em>In</em><b className="num">{money(active.income)}</b></span>
          <span><em>Out</em><b className="num">{money(active.spend)}</b></span>
          <span>
            <em>{saved >= 0 ? 'Kept' : 'Overspent'}</em>
            <b className={`num ${saved >= 0 ? 'pos' : 'over'}`}>{money(Math.abs(saved))}</b>
          </span>
          {rate != null && (
            <span>
              <em>Rate</em>
              <b className={`num ${saved >= 0 ? 'pos' : 'over'}`}>{Math.round(rate)}%</b>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
