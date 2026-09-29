import type { Dispatch, SetStateAction } from 'react'
import { currentMonth, monthLabel, monthShortLabel, shiftMonth } from '../lib/dates'
import { Icon } from './Icon'

interface Props {
  month: string
  setMonth: Dispatch<SetStateAction<string>>
}

/**
 * The header title on the month screens: ‹ September ›. Steps are functional
 * updates (two quick taps move two months, never one) and the forward step is
 * capped at the current month. Tapping the label returns to the current month,
 * as does 'This month' when it fits.
 */
export function MonthSwitch({ month, setMonth }: Props) {
  const cur = currentMonth()
  return (
    <div className="month-switch" role="group" aria-label="Month">
      <button type="button" className="ms-step" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
        <Icon name="chevron" size={18} className="flip" />
      </button>
      <button
        type="button"
        className="ms-label"
        aria-live="polite"
        aria-label={month !== cur ? `Back to ${monthLabel(cur)}` : monthLabel(month)}
        onClick={() => setMonth(cur)}
      >
        {monthShortLabel(month)}
      </button>
      <button
        type="button"
        className="ms-step"
        aria-label="Next month"
        disabled={month >= cur}
        onClick={() =>
          setMonth((m) => {
            const next = shiftMonth(m, 1)
            return next > cur ? m : next
          })
        }
      >
        <Icon name="chevron" size={18} />
      </button>
      {month !== cur && (
        <button type="button" className="ms-today" onClick={() => setMonth(cur)}>
          This month
        </button>
      )}
    </div>
  )
}
