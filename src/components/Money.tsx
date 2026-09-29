import { money, moneyParts, type MoneyOpts } from '../lib/format'

interface Props extends MoneyOpts {
  value: number
  className?: string
}

/**
 * A single display figure with quieter cents (.money-dec). Use it for heroes and
 * single display figures only; row figures stay plain money() strings.
 * innerText is exactly money(value, opts), so text dumps and copy/paste read the
 * true figure.
 */
export function Money({ value, className, sign, approx, trim }: Props) {
  const opts: MoneyOpts = { sign, approx, trim }
  const { whole, cents } = moneyParts(value, opts)
  return (
    <span className={`money num${className ? ` ${className}` : ''}`} aria-label={money(value, opts)}>
      {whole}
      {cents && (
        <span className="money-dec" aria-hidden="true">
          {cents}
        </span>
      )}
    </span>
  )
}
