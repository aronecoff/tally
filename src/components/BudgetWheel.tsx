import { money } from '../lib/format'

export interface WheelSlice {
  key: string
  name: string
  spent: number
  limit: number
  state: 'ok' | 'near' | 'pace' | 'over' | 'none'
}

interface Props {
  slices: WheelSlice[]
  totalLimit: number
  totalSpent: number
  selected: string | null
  onSelect: (key: string | null) => void
}

const CX = 110
const CY = 110
const R_OUT = 100
const R_IN = 70 // a thinner ring reads more refined than a fat one
const GAP = 0.018

/**
 * Category colours, tuned to the app's earth palette. The colours seeded in the
 * DB are bright Tailwind defaults (#4ade80, #fb7185 …) that clash badly here and
 * were never actually rendered anywhere, so the wheel keys off the category NAME
 * instead and stays consistent with the rest of the UI.
 */
const CAT_COLORS: Record<string, string> = {
  rent: '#6F91A3',
  groceries: '#6E8060',
  dining: '#C98A7E',
  transport: '#C9A86B',
  subscriptions: '#8C7FA8',
  health: '#B9808F',
  shopping: '#8FA083',
  fun: '#B08E5E',
  other: '#8A867E',
  uncategorized: '#8A867E',
}
const PALETTE = ['#6F91A3', '#6E8060', '#C98A7E', '#C9A86B', '#8C7FA8', '#B9808F', '#8FA083', '#B08E5E', '#8A867E']

function colorFor(name: string): string {
  const k = name.trim().toLowerCase()
  if (CAT_COLORS[k]) return CAT_COLORS[k]
  let h = 0
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/** Annular sector. Angles in radians, 0 = 12 o'clock, clockwise. */
function sector(rIn: number, rOut: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0
  const pt = (r: number, a: number) => [CX + r * Math.sin(a), CY - r * Math.cos(a)] as const
  const [x0, y0] = pt(rOut, a0)
  const [x1, y1] = pt(rOut, a1)
  const [x2, y2] = pt(rIn, a1)
  const [x3, y3] = pt(rIn, a0)
  return `M${x0},${y0} A${rOut},${rOut} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${rIn},${rIn} 0 ${large} 0 ${x3},${y3} Z`
}

/**
 * Budget wheel — a uniform-thickness donut of where the money actually went.
 * Angle = that category's share of this month's spending; one colour per
 * category so slices are tellable apart. Over-budget categories are flagged in
 * the legend rather than by recolouring the slice, so category identity stays
 * readable.
 */
export function BudgetWheel({ slices, totalLimit, totalSpent, selected, onSelect }: Props) {
  const spentSlices = slices.filter((s) => s.spent > 0)
  const total = spentSlices.reduce((n, s) => n + s.spent, 0)
  if (total <= 0) return null

  const left = totalLimit - totalSpent
  const sel = spentSlices.find((s) => s.key === selected) ?? null

  let cursor = 0
  const arcs = spentSlices.map((s) => {
    const a0 = cursor
    const a1 = cursor + (s.spent / total) * Math.PI * 2
    cursor = a1
    return { ...s, a0, a1, color: colorFor(s.name), pct: (s.spent / total) * 100 }
  })

  return (
    <>
      <div className="wheel-wrap">
        <svg className="wheel" viewBox="0 0 220 220" role="img" aria-label="Spending by category">
          {arcs.map((a) => {
            const a0 = a.a0 + GAP / 2
            const a1 = Math.max(a0 + 0.004, a.a1 - GAP / 2)
            return (
              <path
                key={a.key}
                className={`wheel-slice ${selected === a.key ? 'sel' : ''} ${selected && selected !== a.key ? 'dim' : ''}`}
                d={sector(R_IN, R_OUT, a0, a1)}
                fill={a.color}
                onClick={() => onSelect(selected === a.key ? null : a.key)}
              />
            )
          })}
        </svg>

        <div className="wheel-center">
          {sel ? (
            <>
              <span className="wheel-center-label">{sel.name}</span>
              <strong className="wheel-center-num num">{money(sel.spent, { approx: true })}</strong>
              <span className="wheel-center-sub num">
                {sel.limit > 0 ? `of ${money(sel.limit, { approx: true })}` : 'no budget'}
              </span>
            </>
          ) : (
            <>
              <span className="wheel-center-label">{left >= 0 ? 'Left to spend' : 'Over budget'}</span>
              <strong className={`wheel-center-num num ${left < 0 ? 'over' : ''}`}>
                {money(Math.abs(left), { approx: true })}
              </strong>
              <span className="wheel-center-sub num">of {money(totalLimit, { approx: true })}</span>
            </>
          )}
        </div>
      </div>

      <ul className="wheel-key">
        {arcs.map((a) => (
          <li
            key={a.key}
            className={`wheel-key-row ${selected === a.key ? 'sel' : ''}`}
            onClick={() => onSelect(selected === a.key ? null : a.key)}
          >
            <i className="wheel-key-dot" style={{ background: a.color }} />
            <span className="wheel-key-name">{a.name}</span>
            <span className={`wheel-key-amt num ${a.state === 'over' ? 'over' : ''}`}>
              {money(a.spent, { approx: true })}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}
