import { useId, type CSSProperties } from 'react'
import { money } from '../lib/format'
import { NO_BUDGET } from '../lib/copy'
import { Icon } from './Icon'
import { Money } from './Money'

export interface WheelSlice {
  key: string
  name: string
  spent: number
  limit: number
  state: 'ok' | 'near' | 'pace' | 'over' | 'none'
  /** Transactions filed under this category this month. */
  count: number
}

interface Props {
  /** Largest first; slices with no spend are skipped. */
  slices: WheelSlice[]
  totalLimit: number
  totalSpent: number
  selected: string | null
  onSelect: (key: string | null) => void
  /** Scroll to the selected category's row. */
  onGo?: (key: string) => void
}

const CX = 110
const CY = 110
const R_OUT = 100
const R_IN = 70 // a thinner ring reads more refined than a fat one

/**
 * Category colours: the approved earth palette, as themable tokens
 * (--cat-*, tokens.css, with light-mode variants). The colours seeded in the DB
 * are bright defaults that were never rendered, so the wheel keys off the
 * category NAME. Applied through style (var() is not reliable in SVG
 * presentation attributes in WebKit).
 */
const CAT_KEYS = new Set(['rent', 'groceries', 'shopping', 'transport', 'dining', 'subscriptions', 'health', 'fun', 'other'])
/** Hashed fallback for custom categories: the same palette minus Other's grey. */
const PALETTE = ['rent', 'groceries', 'dining', 'transport', 'subscriptions', 'health', 'shopping', 'fun'].map(
  (k) => `var(--cat-${k})`,
)

function colorFor(name: string): string {
  const k = name.trim().toLowerCase()
  if (CAT_KEYS.has(k)) return `var(--cat-${k})`
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
 * Budget wheel: a uniform-thickness donut of where the money actually went.
 * Angle = that category's share of this month's spending, largest first; one
 * colour per category so slices are tellable apart, and Uncategorized is
 * hatched (unsorted money looks unsorted). A category's state shows in the
 * legend amount and the centre, never by recolouring its slice. The ring is
 * decorative for assistive tech; the legend buttons are the controls.
 */
export function BudgetWheel({ slices, totalLimit, totalSpent, selected, onSelect, onGo }: Props) {
  const hatchId = `wheel-hatch-${useId().replace(/[^\w-]/g, '')}`
  const spentSlices = slices.filter((s) => s.spent > 0)
  const total = spentSlices.reduce((n, s) => n + s.spent, 0)
  if (total <= 0) return null

  const left = totalLimit - totalSpent
  const sel = spentSlices.find((s) => s.key === selected) ?? null
  // Only a slice with spend can be the selection: opening an unspent category
  // in the list must not dim the whole ring.
  const activeKey = sel?.key ?? null

  const arcs: (WheelSlice & { a0: number; a1: number; color: string; hatch: boolean })[] = []
  let cursor = 0
  for (const s of spentSlices) {
    const a0 = cursor
    cursor += (s.spent / total) * Math.PI * 2
    arcs.push({ ...s, a0, a1: cursor, color: colorFor(s.name), hatch: s.key === 'uncat' })
  }

  const toggle = (key: string) => onSelect(selected === key ? null : key)
  const dot = (a: { color: string; hatch: boolean }, className: string) =>
    a.hatch ? <i className={`${className} is-hatch`} /> : <i className={className} style={{ background: a.color }} />

  const selArc = arcs.find((a) => a.key === activeKey) ?? null
  const selTone = sel ? (sel.state === 'over' ? 'over' : sel.state === 'pace' || sel.state === 'near' ? 'near' : '') : ''
  const selSub = sel
    ? sel.state === 'over'
      ? `${money(sel.spent - sel.limit)} over`
      : sel.state === 'pace'
        ? 'Likely to go over'
        : sel.limit > 0
          ? `of ${money(sel.limit, { trim: true })}`
          : NO_BUDGET
    : ''

  return (
    <>
      <div className="wheel-wrap" aria-live="polite">
        <svg className="wheel" viewBox="0 0 220 220" aria-hidden="true">
          <defs>
            <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="4" height="4" style={{ fill: 'var(--cat-other)', fillOpacity: 0.3 }} />
              <rect width="1.6" height="4" style={{ fill: 'var(--cat-other)' }} />
            </pattern>
          </defs>
          {/* The hole clears the selection. */}
          <circle className="wheel-hole" cx={CX} cy={CY} r={R_IN} fill="transparent" onClick={() => onSelect(null)} />
          {arcs.map((a) => {
            // Uniform gaps come from the background-coloured stroke, not from
            // angular gaps (which taper toward the hub).
            const a0 = a.a0
            const a1 = Math.min(Math.max(a0 + 0.004, a.a1), a0 + Math.PI * 2 - 1e-4)
            return (
              <path
                key={a.key}
                className={`wheel-slice${activeKey === a.key ? ' sel' : ''}${activeKey && activeKey !== a.key ? ' dim' : ''}`}
                d={sector(R_IN, R_OUT, a0, a1)}
                {...(a.hatch ? { fill: `url(#${hatchId})` } : { style: { fill: a.color } })}
                onClick={() => toggle(a.key)}
              />
            )
          })}
        </svg>

        <div className="wheel-center" key={activeKey ?? 'all'}>
          {sel && selArc ? (
            <>
              <span className="wheel-center-label">
                {dot(selArc, 'wheel-center-dot')}
                {sel.name}
              </span>
              <Money className="wheel-center-num" value={sel.spent} />
              <span className={`wheel-center-sub num${selTone ? ` ${selTone}` : ''}`}>{selSub}</span>
            </>
          ) : totalLimit > 0 ? (
            <>
              <span className="wheel-center-label">{left >= 0 ? 'Left' : 'Over budget'}</span>
              <Money className={`wheel-center-num${left < 0 ? ' over' : ''}`} value={Math.abs(left)} />
              <span className="wheel-center-sub num">of {money(totalLimit, { trim: true })}</span>
            </>
          ) : (
            <>
              <span className="wheel-center-label">Spent</span>
              <Money className="wheel-center-num" value={totalSpent} />
            </>
          )}
        </div>
      </div>

      {/* Reserved slot: the legend never moves when a slice is picked. */}
      <div className="wheel-go-slot">
        {sel && onGo && (
          <button type="button" className="wheel-go" key={sel.key} onClick={() => onGo(sel.key)}>
            {sel.count} {sel.count === 1 ? 'transaction' : 'transactions'} in {sel.name}
            <Icon name="chevron" size={12} />
          </button>
        )}
      </div>

      <ul
        className={`wheel-key${activeKey ? ' has-sel' : ''}`}
        style={{ '--rows': Math.ceil(arcs.length / 2) } as CSSProperties}
      >
        {arcs.map((a) => (
          <li key={a.key}>
            <button
              type="button"
              className={`wheel-key-row${activeKey === a.key ? ' sel' : ''}`}
              aria-pressed={activeKey === a.key}
              onClick={() => toggle(a.key)}
            >
              {dot(a, 'wheel-key-dot')}
              <span className="wheel-key-name">{a.name}</span>
              <span className={`wheel-key-amt num${a.state === 'over' ? ' over' : ''}`}>
                {money(a.spent, { approx: true })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
