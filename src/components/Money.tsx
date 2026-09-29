import { moneyParts, type MoneyOpts } from '../lib/format'

interface Props extends MoneyOpts {
  value: number
  className?: string
}

/**
 * A single display figure with quieter cents (.money-dec). Use it for heroes and
 * single display figures only; row figures stay plain money() strings.
 * innerText is exactly money(value, opts), so text dumps and copy/paste read the
 * true figure. Assistive tech reads that same text: the cents are not hidden and
 * there is no aria-label, which a plain span cannot carry reliably (ARIA 1.2
 * prohibits naming generic elements; Chrome exposed '$5,525' without the cents).
 */
export function Money({ value, className, sign, approx, trim }: Props) {
  const opts: MoneyOpts = { sign, approx, trim }
  const { whole, cents } = moneyParts(value, opts)
  return (
    <span className={`money num${className ? ` ${className}` : ''}`}>
      {whole}
      {cents && <span className="money-dec">{cents}</span>}
    </span>
  )
}
