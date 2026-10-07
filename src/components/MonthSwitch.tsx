import { startTransition, useRef, type Dispatch, type SetStateAction } from 'react'
import { monthLabel, monthShortLabel, shiftMonth } from '../lib/dates'
import { useToday } from '../lib/useToday'
import { Icon } from './Icon'

interface Props {
  month: string
  setMonth: Dispatch<SetStateAction<string>>
}

/**
 * The header title on the month screens: September between two chevrons. Steps are functional
 * updates (two quick taps move two months, never one) and the forward step is
 * capped at the current month. Tapping the label returns to the current month,
 * as does 'This month' when it fits.
 *
 * Keyboard focus never drops to <body>: at the current month Next is
 * aria-disabled (a disabled button loses its focus) and does nothing, and
 * 'This month' hands focus to the label before it unmounts.
 *
 * Every step is a transition: the month screens suspend until the new month's
 * rows are in, and React keeps this label and the old figures up together
 * meanwhile, so the new label never sits over the old month's numbers.
 */
export function MonthSwitch({ month, setMonth: setNow }: Props) {
  const cur = useToday().slice(0, 7)
  const setMonth: Props['setMonth'] = (v) => startTransition(() => setNow(v))
  const labelRef = useRef<HTMLButtonElement>(null)
  const atCur = month >= cur
  return (
    <div className="month-switch" role="group" aria-label="Month">
      <button type="button" className="ms-step" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
        <Icon name="chevron" size={18} className="flip" />
      </button>
      <button
        ref={labelRef}
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
        aria-disabled={atCur}
        onClick={() => {
          if (atCur) return
          setMonth((m) => {
            const next = shiftMonth(m, 1)
            return next > cur ? m : next
          })
        }}
      >
        <Icon name="chevron" size={18} />
      </button>
      {month !== cur && (
        <button
          type="button"
          className="ms-today"
          onClick={(e) => {
            // Only when it held keyboard focus: a tap (iOS does not focus a
            // tapped button) must not paint a focus ring on the label.
            if (document.activeElement === e.currentTarget) labelRef.current?.focus()
            setMonth(cur)
          }}
        >
          This month
        </button>
      )}
    </div>
  )
}
